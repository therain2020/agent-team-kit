import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const webRoot = path.join(repoRoot, "apps", "web");
const distDir = process.env.KIT_WEB_DIST_DIR ?? ".next-bench";
const samples = clampInt(process.env.BENCH_SAMPLES, 1, 20, 4);
const p50Limit = clampInt(process.env.BENCH_P50_MS, 1, 60_000, 300);
const p95Limit = clampInt(process.env.BENCH_P95_MS, 1, 120_000, 600);
const requestTimeout = clampInt(
  process.env.BENCH_TIMEOUT_MS,
  1_000,
  120_000,
  30_000,
);
const routes = (
  process.env.BENCH_ROUTES ??
  "/,/runs,/inbox,/packs,/evolution,/manager,/office,/sources,/autopilot,/traces"
)
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean);

const env = {
  ...process.env,
  KIT_WEB_DIST_DIR: distDir,
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
};

let server: ChildProcess | undefined;
let serverLogs = "";

try {
  const build = await runCommand(bunBin(), ["run", "web:build"], {
    cwd: repoRoot,
    env,
    timeoutMs: 15 * 60_000,
  });
  if (build.exitCode !== 0) {
    console.error("[bench] web build failed");
    console.error(tail(build.stdout));
    console.error(tail(build.stderr));
    process.exit(1);
  }

  const port = await freePort();
  const nextCli = path.join(
    webRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  server = spawn(
    process.env.KIT_NODE_BIN ?? "node",
    [nextCli, "start", "-p", String(port)],
    {
      cwd: webRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    serverLogs = tail(`${serverLogs}${chunk.toString("utf8")}`, 20_000);
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverLogs = tail(`${serverLogs}${chunk.toString("utf8")}`, 20_000);
  });

  const base = `http://127.0.0.1:${port}`;
  const healthy = await waitFor(`${base}/api/health`, 90_000);
  if (!healthy) {
    console.error("[bench] production server did not become healthy");
    console.error(tail(serverLogs));
    process.exit(1);
  }

  const results: Array<{
    route: string;
    p50: number;
    p95: number;
    samples: number[];
  }> = [];
  for (const route of routes) {
    const timings: number[] = [];
    for (let index = 0; index <= samples; index += 1) {
      const started = performance.now();
      const response = await fetch(`${base}${route}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeout),
      });
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      if (!response.ok) {
        throw new Error(`${route} returned ${response.status}`);
      }
      if (index > 0) {
        timings.push(Math.round(elapsed));
      }
    }
    const sorted = [...timings].sort((a, b) => a - b);
    results.push({
      route,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      samples: timings,
    });
  }

  const failed = results.filter(
    (result) => result.p50 > p50Limit || result.p95 > p95Limit,
  );
  console.log(
    JSON.stringify(
      {
        mode: "production",
        distDir,
        samples,
        thresholds: { p50Ms: p50Limit, p95Ms: p95Limit },
        results,
        pass: failed.length === 0,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    console.error(
      `[bench] exceeded thresholds: ${failed
        .map((item) => `${item.route} p50=${item.p50}ms p95=${item.p95}ms`)
        .join("; ")}`,
    );
    process.exit(1);
  }
} finally {
  if (server) {
    await killTree(server);
  }
}

function bunBin(): string {
  return process.env.KIT_BUN_BIN ?? "bun";
}

async function freePort(): Promise<number> {
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

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
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

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

async function killTree(child: ChildProcess): Promise<void> {
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

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function tail(value: string, limit = 4_000): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function clampInt(
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
