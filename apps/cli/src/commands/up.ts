import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { parseWebMode, resolveWebMode } from "../web-mode";

interface SupervisorState {
  supervisorPid: number;
  startedAt: string;
  repoRoot: string;
  web: boolean;
  webMode?: "production" | "dev" | null;
  children: Array<{
    name: string;
    pid?: number;
    restarts: number;
    lastError?: string;
  }>;
  updatedAt: string;
}

export function registerUp(program: Command): void {
  const up = program
    .command("up")
    .description("Start infra and the supervised agent-team runtime")
    .option("--web", "also start the Manager Console", false)
    .option(
      "--web-mode <mode>",
      "Manager Console mode with --web: production or dev (default: KIT_WEB_MODE or dev)",
    )
    .option("--no-infra", "skip docker compose and use existing infra")
    .option(
      "--foreground",
      "keep the supervisor attached to this terminal",
      false,
    )
    .action(
      async (options: {
        web: boolean;
        infra: boolean;
        foreground: boolean;
        webMode?: string;
      }) => {
        await start(options);
      },
    );

  up.command("status")
    .description("Show supervisor and service status")
    .action(async () => {
      await status();
    });

  program
    .command("down")
    .description("Stop the supervisor and (optionally) docker compose")
    .option("--keep-infra", "leave docker compose services running", false)
    .action((options: { keepInfra: boolean }) => {
      stop(options);
    });
}

async function start(options: {
  web: boolean;
  infra: boolean;
  foreground: boolean;
  webMode?: string;
}): Promise<void> {
  if (options.webMode && parseWebMode(options.webMode) === null) {
    console.error("✖ --web-mode must be 'production' or 'dev'");
    process.exitCode = 1;
    return;
  }
  const webMode = resolveWebMode(options.webMode ?? process.env.KIT_WEB_MODE);
  const repoRoot = process.cwd();
  const stateDir = path.join(repoRoot, ".tmp", "supervisor");
  const statePath = path.join(stateDir, "state.json");
  mkdirSync(stateDir, { recursive: true });

  const existing = readState(statePath);
  if (existing && isAlive(existing.supervisorPid)) {
    console.log(
      `Supervisor already running (pid ${existing.supervisorPid}). Use "kit up status".`,
    );
    return;
  }

  if (options.infra) {
    console.log("[up] starting docker compose infra...");
    const compose = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        path.join(repoRoot, "deploy", "docker-compose.yml"),
        "up",
        "-d",
      ],
      { cwd: repoRoot, stdio: "inherit", windowsHide: true },
    );
    if (compose.status !== 0) {
      console.error("✖ docker compose failed");
      process.exitCode = 1;
      return;
    }
    const ready = await waitForPorts([
      { host: "127.0.0.1", port: 5432, name: "postgres" },
      { host: "127.0.0.1", port: 9000, name: "minio" },
      { host: "127.0.0.1", port: 4222, name: "nats" },
      { host: "127.0.0.1", port: 7233, name: "temporal" },
    ]);
    if (!ready) {
      console.error("✖ infra did not become ready in time");
      process.exitCode = 1;
      return;
    }
  }

  const supervisorPath = fileURLToPath(
    new URL("../supervisor.ts", import.meta.url),
  );
  const logPath = path.join(stateDir, "supervisor.log");
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, ["run", supervisorPath], {
    cwd: repoRoot,
    detached: !options.foreground,
    stdio: options.foreground ? "inherit" : ["ignore", fd, fd],
    env: {
      ...process.env,
      KIT_SUPERVISOR_WEB: options.web ? "1" : "0",
      KIT_WEB_MODE: webMode,
    },
    windowsHide: true,
  });
  if (!options.foreground) {
    child.unref();
  }
  closeSync(fd);

  if (options.foreground) {
    console.log("[up] supervisor attached; Ctrl+C to stop");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    return;
  }

  const started = await waitForState(statePath, 10_000);
  if (!started) {
    console.error(
      "✖ supervisor did not start; see .tmp/supervisor/supervisor.log",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        supervisorPid: started.supervisorPid,
        web: options.web,
        webMode: options.web ? webMode : undefined,
        gateway: "http://127.0.0.1:8787",
        temporalUi: "http://localhost:8080",
        jaeger: "http://localhost:16686",
        logs: ".tmp/supervisor/*.log",
        next: 'kit up status | kit iterate --goal "..." | kit down',
      },
      null,
      2,
    ),
  );
}

async function status(): Promise<void> {
  const repoRoot = process.cwd();
  const statePath = path.join(repoRoot, ".tmp", "supervisor", "state.json");
  const state = readState(statePath);
  if (!state) {
    console.log(JSON.stringify({ running: false }, null, 2));
    return;
  }
  const supervisorAlive = isAlive(state.supervisorPid);
  const children = state.children.map((child) => ({
    ...child,
    alive: child.pid ? isAlive(child.pid) : false,
  }));
  const gateway = await fetchHealth("http://127.0.0.1:8787/health");
  const web = state.web
    ? await fetchHealth("http://localhost:3000/api/health")
    : undefined;
  const webMode = state.web ? (state.webMode ?? "dev") : null;
  console.log(
    JSON.stringify(
      {
        running: supervisorAlive,
        supervisorPid: state.supervisorPid,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        gateway,
        web,
        webMode,
        children,
      },
      null,
      2,
    ),
  );
}

function stop(options: { keepInfra: boolean }): void {
  const repoRoot = process.cwd();
  const stateDir = path.join(repoRoot, ".tmp", "supervisor");
  const statePath = path.join(stateDir, "state.json");
  const state = readState(statePath);

  if (state && isAlive(state.supervisorPid)) {
    console.log(`[down] stopping supervisor ${state.supervisorPid}`);
    killPid(state.supervisorPid);
  } else {
    console.log("[down] no running supervisor");
  }
  try {
    rmSync(statePath, { force: true });
  } catch {
    // ignore
  }

  if (!options.keepInfra) {
    console.log("[down] stopping docker compose");
    spawnSync(
      "docker",
      [
        "compose",
        "-f",
        path.join(repoRoot, "deploy", "docker-compose.yml"),
        "down",
      ],
      { cwd: repoRoot, stdio: "inherit", windowsHide: true },
    );
  }
}

function readState(statePath: string): SupervisorState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as SupervisorState;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function waitForState(
  statePath: string,
  timeoutMs: number,
): Promise<SupervisorState | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = readState(statePath);
    if (state && isAlive(state.supervisorPid)) {
      return state;
    }
    await sleep(250);
  }
  return null;
}

async function waitForPorts(
  ports: Array<{ host: string; port: number; name: string }>,
): Promise<boolean> {
  for (const target of ports) {
    const ok = await waitForPort(target.host, target.port, 120_000);
    if (!ok) {
      console.error(
        `✖ ${target.name} did not open ${target.host}:${target.port}`,
      );
      return false;
    }
    console.log(`[up] ${target.name} ready on ${target.port}`);
  }
  return true;
}

async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(host, port)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function fetchHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
