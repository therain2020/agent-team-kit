import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Shared production-build benchmark harness (87 §4.5, 97 §5).
 *
 * `bench:web` (all console routes) and `bench:office` (/office first paint +
 * live state propagation) must build and serve production the same way, or
 * their numbers are not comparable. This module owns that shared part: the
 * isolated dist dir build, the random-port `next start`, server lifecycle and
 * the percentile helpers. Route selection and thresholds stay in each script.
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GeneratedFileSnapshot {
  restore(): Promise<void>;
}

export interface ProductionServer {
  base: string;
  port: number;
  /** Tail of the server stdout/stderr, for failure diagnostics. */
  logs(): string;
  stop(): Promise<void>;
}

export function bunBin(): string {
  return process.env.KIT_BUN_BIN ?? "bun";
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.unref();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = typeof address === "object" && address ? address.port : 0;
      socket.close(() => resolve(port));
    });
  });
}

export async function waitFor(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // server is still starting
    }
    await delay(500);
  }
  return false;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      void killTree(child);
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(`${stdout}${chunk.toString("utf8")}`, 200_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(`${stderr}${chunk.toString("utf8")}`, 200_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // process may already be gone
  }
}

/**
 * Next rewrites `next-env.d.ts` and `tsconfig.json` during `next build`.
 * Bench runs must leave the working tree the way they found it (87 §8).
 */
export async function preserveGeneratedFiles(
  webRoot: string,
): Promise<GeneratedFileSnapshot> {
  const files = ["next-env.d.ts", "tsconfig.json"].map((name) =>
    path.join(webRoot, name),
  );
  const originals = new Map<string, string>();
  for (const file of files) {
    try {
      originals.set(file, await readFile(file, "utf8"));
    } catch {
      // file may not exist yet
    }
  }
  return {
    async restore() {
      for (const [file, content] of originals) {
        try {
          await writeFile(file, content, "utf8");
        } catch {
          // best-effort restore; the build already succeeded or failed
        }
      }
    },
  };
}

/** Builds the web app once into the caller-provided dist dir. */
export async function buildWeb(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15 * 60_000,
): Promise<CommandResult> {
  return await runCommand(bunBin(), ["run", "web:build"], {
    cwd: repoRoot,
    env,
    timeoutMs,
  });
}

/**
 * Workspace installs hoist `next` to the repo root, and its `exports` map does
 * not promise the bin subpath, so try the resolved package dir first and then
 * the two node_modules layouts bun produces.
 */
function resolveNextCli(webRoot: string): string {
  const candidates: string[] = [];
  try {
    const webRequire = createRequire(path.join(webRoot, "package.json"));
    const packageJson = webRequire.resolve("next/package.json");
    candidates.push(
      path.join(path.dirname(packageJson), "dist", "bin", "next"),
    );
  } catch {
    // fall through to the conventional layouts
  }
  candidates.push(
    path.join(webRoot, "node_modules", "next", "dist", "bin", "next"),
    path.join(
      webRoot,
      "..",
      "..",
      "node_modules",
      "next",
      "dist",
      "bin",
      "next",
    ),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("[bench] next is not installed; run `bun install` first");
}

/**
 * Starts `next start` on a free loopback port and waits for the health route.
 * The caller owns the returned handle and must call `stop()` in `finally`.
 */
export async function startProductionServer(options: {
  webRoot: string;
  env: NodeJS.ProcessEnv;
  healthPath?: string;
  healthTimeoutMs?: number;
}): Promise<ProductionServer> {
  const port = await freePort();
  const nextCli = resolveNextCli(options.webRoot);
  let logs = "";
  const server = spawn(
    process.env.KIT_NODE_BIN ?? "node",
    [nextCli, "start", "-p", String(port)],
    {
      cwd: options.webRoot,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    logs = tail(`${logs}${chunk.toString("utf8")}`, 20_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    logs = tail(`${logs}${chunk.toString("utf8")}`, 20_000);
  });

  const stop = async () => {
    await killTree(server);
  };
  const base = `http://127.0.0.1:${port}`;
  const healthy = await waitFor(
    `${base}${options.healthPath ?? "/api/health"}`,
    options.healthTimeoutMs ?? 90_000,
  );
  if (!healthy) {
    await stop();
    throw new Error(
      `[bench] production server did not become healthy\n${tail(logs)}`,
    );
  }
  return {
    base,
    port,
    logs: () => logs,
    stop,
  };
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function tail(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

export function clampInt(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function clampNumber(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
