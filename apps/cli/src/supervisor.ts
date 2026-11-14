import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { FileLockTimeoutError, acquireFileLock } from "@kit/core";
import { resolveWebMode, webRunArgs } from "./web-mode";

interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  health?: string;
}

interface ChildRecord {
  name: string;
  pid?: number;
  restarts: number;
  startedAt?: string;
  lastExitAt?: string;
  lastError?: string;
  consecutiveHealthFailures: number;
}

const repoRoot = process.cwd();
const stateDir = path.join(repoRoot, ".tmp", "supervisor");
mkdirSync(stateDir, { recursive: true });

const statePath = path.join(stateDir, "state.json");
const startedAt = new Date().toISOString();

let supervisorLock: Awaited<ReturnType<typeof acquireFileLock>> | null = null;
try {
  supervisorLock = await acquireFileLock(
    path.join(stateDir, "supervisor.lock"),
    {
      owner: `supervisor:${process.pid}`,
      timeoutMs: 1000,
      staleMs: 2 * 60 * 1000,
      heartbeatMs: 10_000,
    },
  );
} catch (error) {
  if (error instanceof FileLockTimeoutError) {
    console.error(
      `[supervisor] another supervisor is running (${error.lockPath})`,
    );
    process.exit(0);
  }
  throw error;
}
const withWeb = process.env.KIT_SUPERVISOR_WEB === "1";
const webMode = resolveWebMode(process.env.KIT_WEB_MODE);
const children = new Map<string, ChildRecord>();
const processes = new Map<string, ChildProcess>();
const backoff = new Map<string, number>();
let webBuildProcess: ChildProcess | undefined;
let stopping = false;

const bun = process.versions.bun ? process.execPath : "bun";
const tsx = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.exe" : "tsx",
);

const localMode =
  process.env.KIT_RUNTIME_MODE === "local" ||
  process.env.KIT_DB_DRIVER === "sqlite";

const specs: ChildSpec[] = localMode
  ? [
      {
        name: "local-runner",
        command: tsx,
        args: ["apps/runtime/src/local-runner.ts"],
      },
    ]
  : [
      {
        name: "runtime",
        command: bun,
        args: ["apps/runtime/src/index.ts"],
      },
      {
        name: "worker",
        command: tsx,
        args: ["apps/runtime/src/temporal/worker.ts"],
      },
      {
        name: "autopilot",
        command: tsx,
        args: ["apps/runtime/src/autopilot.ts"],
      },
      {
        name: "gateway",
        command: bun,
        args: ["apps/gateway/src/index.ts"],
        health: `http://${process.env.KIT_GATEWAY_HOST ?? "127.0.0.1"}:${process.env.KIT_GATEWAY_PORT ?? 8787}/health`,
      },
    ];

const webSpec: ChildSpec | null = withWeb
  ? {
      name: "web",
      command: bun,
      args: webRunArgs(webMode),
      health: "http://localhost:3000/api/health",
    }
  : null;
if (webSpec) {
  specs.push(webSpec);
}

console.log(
  `[supervisor] started pid=${process.pid} repo=${repoRoot} web=${withWeb ? webMode : "off"}`,
);
writeState();
for (const spec of specs) {
  if (spec.name === "web") {
    continue;
  }
  startChild(spec);
}

const healthTimer = setInterval(() => {
  void checkHealth();
}, 15_000);
const stateTimer = setInterval(() => {
  writeState();
}, 10_000);

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());

if (webSpec) {
  void startWeb(webSpec);
}

async function checkHealth(): Promise<void> {
  for (const spec of specs) {
    if (!spec.health) {
      continue;
    }
    const state = children.get(spec.name);
    if (!state) {
      continue;
    }
    const ok = await fetchHealth(spec.health);
    if (ok) {
      state.consecutiveHealthFailures = 0;
      continue;
    }
    state.consecutiveHealthFailures += 1;
    console.error(
      `[supervisor] ${spec.name} health failed (${state.consecutiveHealthFailures})`,
    );
    if (state.consecutiveHealthFailures >= 3) {
      state.consecutiveHealthFailures = 0;
      restart(spec, "health check failed");
    }
  }
  writeState();
}

async function fetchHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startWeb(spec: ChildSpec): Promise<void> {
  if (webMode === "production" && !(await ensureWebBuild())) {
    console.error(
      "[supervisor] web not started: production build failed; see .tmp/supervisor/web-build.log",
    );
    return;
  }
  if (!stopping) {
    startChild(spec);
  }
}

async function ensureWebBuild(): Promise<boolean> {
  const distDir = path.join(
    repoRoot,
    "apps",
    "web",
    process.env.KIT_WEB_DIST_DIR ?? ".next",
  );
  const buildIdPath = path.join(distDir, "BUILD_ID");
  if (existsSync(buildIdPath)) {
    return true;
  }

  console.log("[supervisor] building Manager Console for production...");
  const logPath = path.join(stateDir, "web-build.log");
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(bun, ["run", "web:build"], {
      cwd: repoRoot,
      env: { ...process.env, KIT_WEB_MODE: "production" },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    webBuildProcess = child;
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        console.error(`[supervisor] web build error: ${error.message}`);
        resolve(null);
      });
      child.once("exit", (exitCode) => resolve(exitCode));
    });
    webBuildProcess = undefined;
    if (code !== 0) {
      console.error(`[supervisor] web build failed; see ${logPath}`);
      return false;
    }
    if (!existsSync(buildIdPath)) {
      console.error(`[supervisor] web build produced no ${buildIdPath}`);
      return false;
    }
    console.log("[supervisor] Manager Console build ready");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[supervisor] web build error: ${message}`);
    return false;
  } finally {
    closeSync(fd);
  }
}

function startChild(spec: ChildSpec): void {
  if (stopping) {
    return;
  }
  const logPath = path.join(stateDir, `${spec.name}.log`);
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(spec.command),
    });
    processes.set(spec.name, child);

    const existing = children.get(spec.name);
    const record: ChildRecord = {
      name: spec.name,
      ...(child.pid ? { pid: child.pid } : {}),
      restarts: existing?.restarts ?? 0,
      startedAt: new Date().toISOString(),
      consecutiveHealthFailures: 0,
    };
    children.set(spec.name, record);
    console.log(
      `[supervisor] started ${spec.name}${child.pid ? ` pid=${child.pid}` : ""}`,
    );
    writeState();

    child.on("error", (error) => {
      record.lastError = error.message;
      console.error(`[supervisor] ${spec.name} error: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      record.lastExitAt = new Date().toISOString();
      record.lastError = `exit code=${code ?? "null"} signal=${signal ?? "none"}`;
      processes.delete(spec.name);
      console.error(`[supervisor] ${spec.name} exited (${record.lastError})`);
      writeState();
      if (!stopping) {
        scheduleRestart(spec);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = children.get(spec.name) ?? {
      name: spec.name,
      restarts: 0,
      consecutiveHealthFailures: 0,
    };
    record.lastError = message;
    children.set(spec.name, record);
    console.error(`[supervisor] failed to start ${spec.name}: ${message}`);
    writeState();
    scheduleRestart(spec);
  } finally {
    closeSync(fd);
  }
}

function restart(spec: ChildSpec, reason: string): void {
  const child = processes.get(spec.name);
  if (child) {
    console.error(`[supervisor] restarting ${spec.name}: ${reason}`);
    killChild(child);
    return;
  }
  startChild(spec);
}

function scheduleRestart(spec: ChildSpec): void {
  const record = children.get(spec.name);
  if (record) {
    record.restarts += 1;
  }
  const delay = backoff.get(spec.name) ?? 1000;
  backoff.set(spec.name, Math.min(delay * 2, 30_000));
  console.log(
    `[supervisor] restarting ${spec.name} in ${Math.round(delay / 1000)}s`,
  );
  setTimeout(() => {
    backoff.set(spec.name, 1000);
    startChild(spec);
  }, delay);
}

function killChild(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
}

function writeState(): void {
  const payload = {
    supervisorPid: process.pid,
    startedAt,
    repoRoot,
    web: withWeb,
    webMode: withWeb ? webMode : null,
    children: [...children.values()],
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function shutdown(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("[supervisor] stopping");
  clearInterval(healthTimer);
  clearInterval(stateTimer);
  for (const child of processes.values()) {
    killChild(child);
  }
  if (webBuildProcess) {
    killChild(webBuildProcess);
  }
  writeState();
  supervisorLock?.release();
  supervisorLock = null;
  setTimeout(() => process.exit(0), 500);
}

process.on("uncaughtException", (error) => {
  console.error(`[supervisor] uncaught: ${error.message}`);
});

// Keep the process alive even if every child is restarting.
setInterval(() => {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    void state;
  } catch {
    // state may be mid-write
  }
}, 60_000);
