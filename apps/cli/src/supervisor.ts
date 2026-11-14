import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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
const withWeb = process.env.KIT_SUPERVISOR_WEB === "1";
const children = new Map<string, ChildRecord>();
const processes = new Map<string, ChildProcess>();
const backoff = new Map<string, number>();
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

if (withWeb) {
  specs.push({
    name: "web",
    command: bun,
    args: ["run", "--cwd", "apps/web", "dev"],
    health: "http://localhost:3000/api/health",
  });
}

console.log(`[supervisor] started pid=${process.pid} repo=${repoRoot}`);
writeState();
for (const spec of specs) {
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
  writeState();
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
