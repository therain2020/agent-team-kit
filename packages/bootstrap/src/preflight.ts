import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadApiKey } from "./keyring";
import { bootstrapHome } from "./paths";
import {
  type ModelProbeResult,
  type ProbeErrorKind,
  probeModel,
} from "./probe";
import { readBootstrapProfileSync } from "./profile";

export type RuntimeMode = "local" | "scale";
export type PreflightLevel = "ok" | "warn" | "fail" | "info";

export interface PreflightCheck {
  id: string;
  label: string;
  level: PreflightLevel;
  detail: string;
  fix?: string;
}

export interface PreflightReport {
  mode: RuntimeMode;
  checks: PreflightCheck[];
  actions: string[];
  ok: boolean;
}

export interface PreflightProbes {
  which?: (command: string) => string | null;
  run?: (command: string, args: string[]) => string | null;
  portOpen?: (port: number, timeoutMs?: number) => Promise<boolean>;
  probeModel?: typeof probeModel;
}

export interface PreflightOptions extends PreflightProbes {
  env?: Record<string, string | undefined>;
  mode?: RuntimeMode;
  probe?: boolean;
  probeResult?: ModelProbeResult;
  probeTimeoutMs?: number;
  includeToolchain?: boolean;
  localDbPath?: string;
}

interface ServiceSpec {
  id: string;
  label: string;
  port: number;
  optional?: boolean;
}

const SERVICES: readonly ServiceSpec[] = [
  { id: "postgres", label: "Postgres", port: 5432 },
  { id: "nats", label: "NATS", port: 4222 },
  { id: "temporal", label: "Temporal", port: 7233 },
  { id: "console", label: "console", port: 3000, optional: true },
];

export interface CoderSpec {
  id: "dsh" | "codex" | "opencode" | "pi";
  binary: string;
  install: string[];
  purpose: string;
}

export const CODER_SPECS: readonly CoderSpec[] = [
  {
    id: "dsh",
    binary: "dsh",
    install: ["npm", "install", "-g", "@deepseek-ai/dsh"],
    purpose: "default external coder for kit iterate",
  },
  {
    id: "codex",
    binary: "codex",
    install: ["npm", "install", "-g", "@openai/codex"],
    purpose: "external coder via KIT_CODER_CODEX_CMD",
  },
  {
    id: "opencode",
    binary: "opencode",
    install: ["npm", "install", "-g", "@opencode/cli"],
    purpose: "external coder via KIT_CODER_OPENCODE_CMD",
  },
  {
    id: "pi",
    binary: "pi",
    install: [
      "npm",
      "install",
      "-g",
      "--ignore-scripts",
      "@earendil-works/pi-coding-agent",
    ],
    purpose: "external coder via KIT_CODER_COMMAND",
  },
];

export interface CoderDetection {
  spec: CoderSpec;
  path: string | null;
}

export interface CoderInstallResult {
  id: string;
  command: string;
  ok: boolean;
  output?: string;
}

// The runtime still selects mode from env only; the profile field is written
// for the later D-61 default switch and is not read back here.
export function resolveRuntimeMode(
  env: Record<string, string | undefined> = process.env,
): RuntimeMode {
  if (env.KIT_RUNTIME_MODE === "local") {
    return "local";
  }
  if (env.KIT_RUNTIME_MODE === "scale") {
    return "scale";
  }
  if (env.KIT_DB_DRIVER === "sqlite") {
    return "local";
  }
  if (env.KIT_DB_DRIVER === "postgres" || env.KIT_DB_URL) {
    return "scale";
  }
  return "scale";
}

export async function collectPreflight(
  options: PreflightOptions = {},
): Promise<PreflightReport> {
  const env = options.env ?? process.env;
  const mode = options.mode ?? resolveRuntimeMode(env);
  const which = options.which ?? commandOnPath;
  const run = options.run ?? runCommand;
  const portOpen = options.portOpen ?? isPortOpen;
  const probe = options.probeModel ?? probeModel;
  const profile = readBootstrapProfileSync(env);
  const checks: PreflightCheck[] = [];

  checks.push({
    id: "mode",
    label: "mode",
    level: "info",
    detail:
      mode === "local"
        ? "local — embedded SQLite, no Docker required"
        : "scale — Postgres, NATS and Temporal from Docker Compose",
  });

  if (options.includeToolchain !== false) {
    checks.push(...toolchainChecks(run));
  }

  const docker = run("docker", ["--version"]);
  if (mode === "local") {
    checks.push(
      docker
        ? {
            id: "docker",
            label: "docker",
            level: "ok",
            detail: `${docker} — not required in local mode`,
          }
        : {
            id: "docker",
            label: "docker",
            level: "info",
            detail:
              "not required in local mode; install it only for Scale Mode",
          },
    );
    checks.push({
      id: "services",
      label: "services",
      level: "info",
      detail: "not required in local mode (in-process runner, embedded store)",
    });
    checks.push(localDbCheck(env, options.localDbPath));
  } else {
    checks.push(
      docker
        ? {
            id: "docker",
            label: "docker",
            level: "ok",
            detail: docker,
          }
        : {
            id: "docker",
            label: "docker",
            level: "fail",
            detail:
              "not found — Scale Mode needs Docker for Postgres, NATS, Temporal and MinIO",
            fix: dockerInstall(),
          },
    );

    if (docker) {
      const compose = run("docker", ["compose", "version"]);
      checks.push(
        compose
          ? {
              id: "docker-compose",
              label: "docker compose",
              level: "ok",
              detail: compose,
            }
          : {
              id: "docker-compose",
              label: "docker compose",
              level: "warn",
              detail:
                "not available — Compose v2 ships with current Docker Desktop",
              fix: dockerInstall(),
            },
      );
    }

    const open = await Promise.all(
      SERVICES.map((service) => portOpen(service.port, 500)),
    );
    SERVICES.forEach((service, index) => {
      checks.push(serviceCheck(service, open[index] === true));
    });
  }

  checks.push(await modelCheck({ env, options, profile, probe }));
  checks.push(...coderChecks(which));

  const actions = [
    ...new Set(
      checks.flatMap((check) =>
        check.level === "ok" || !check.fix ? [] : [check.fix],
      ),
    ),
  ];

  return {
    mode,
    checks,
    actions,
    ok: checks.every((check) => check.level !== "fail"),
  };
}

interface ModelCheckInput {
  env: Record<string, string | undefined>;
  options: PreflightOptions;
  profile: ReturnType<typeof readBootstrapProfileSync>;
  probe: typeof probeModel;
}

async function modelCheck(input: ModelCheckInput): Promise<PreflightCheck> {
  const { env, options, profile, probe } = input;
  const key = env.DEEPSEEK_API_KEY ?? loadApiKey(env);
  if (!key) {
    return {
      id: "model",
      label: "model key",
      level: "warn",
      detail: "missing — paste one at /welcome or run kit bootstrap",
      fix: "kit bootstrap --key <key>",
    };
  }

  const baseUrl = profile?.baseUrl;
  const model = profile?.models.flash ?? "deepseek-flash";
  const result =
    options.probeResult ??
    (options.probe
      ? await probe({
          apiKey: key,
          baseUrl,
          model,
          timeoutMs: options.probeTimeoutMs ?? 8000,
        })
      : undefined);

  if (!result) {
    return {
      id: "model",
      label: "model key",
      level: "info",
      detail: `key configured · ${baseUrl ?? "https://api.deepseek.com"} · ${model}`,
    };
  }

  if (result.ok) {
    return {
      id: "model",
      label: "model key",
      level: "ok",
      detail: `reachable in ${result.latencyMs}ms (${result.model})`,
    };
  }

  const kind = result.error?.kind ?? "unknown";
  return {
    id: "model",
    label: "model key",
    level: "fail",
    detail: `probe failed (${kind}) — ${result.error?.message ?? "no detail"}`,
    fix: modelFix(kind),
  };
}

function modelFix(kind: ProbeErrorKind): string {
  switch (kind) {
    case "auth":
      return "kit bootstrap --key <new-key>";
    case "quota":
      return "check provider quota or wait for the rate limit";
    case "bad_request":
      return "kit bootstrap --base-url <url> --flash <model>";
    case "network":
      return "check the network or proxy, then run kit doctor";
    default:
      return "kit doctor";
  }
}

function toolchainChecks(
  run: (command: string, args: string[]) => string | null,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const bun = (process.versions as Record<string, string | undefined>).bun;
  checks.push(
    bun
      ? { id: "bun", label: "bun", level: "ok", detail: bun }
      : {
          id: "bun",
          label: "bun",
          level: "warn",
          detail: "not running under Bun — use `bun run kit` or install Bun",
          fix: "npm install -g bun",
        },
  );

  const node = run("node", ["--version"]);
  if (!node) {
    checks.push({
      id: "node",
      label: "node",
      level: "fail",
      detail: "not found — Node 24+ runs the Temporal worker",
      fix: nodeInstall(),
    });
  } else {
    const major = Number(node.replace(/^v/, "").split(".")[0]);
    checks.push(
      major >= 24
        ? { id: "node", label: "node", level: "ok", detail: node }
        : {
            id: "node",
            label: "node",
            level: "warn",
            detail: `${node} — Node 24+ is required for the Temporal worker`,
            fix: nodeInstall(),
          },
    );
  }

  return checks;
}

function serviceCheck(service: ServiceSpec, open: boolean): PreflightCheck {
  if (open) {
    return {
      id: `service:${service.id}`,
      label: service.label.toLowerCase(),
      level: "ok",
      detail: `reachable on 127.0.0.1:${service.port}`,
    };
  }
  if (service.optional) {
    return {
      id: `service:${service.id}`,
      label: service.label.toLowerCase(),
      level: "info",
      detail: `closed on 127.0.0.1:${service.port} — the console is optional`,
      fix: "kit up --web",
    };
  }
  return {
    id: `service:${service.id}`,
    label: service.label.toLowerCase(),
    level: "warn",
    detail: `closed on 127.0.0.1:${service.port} — start the stack with kit up`,
    fix: "kit up",
  };
}

function localDbCheck(
  env: Record<string, string | undefined>,
  override?: string,
): PreflightCheck {
  const dbPath =
    override ??
    env.KIT_LOCAL_DB ??
    path.join(bootstrapHome(env), "data", "kit.db");
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    return {
      id: "local-db",
      label: "local db",
      level: "info",
      detail: `will be created on first start: ${dbPath}`,
    };
  }
  try {
    accessSync(dir, constants.W_OK);
    return {
      id: "local-db",
      label: "local db",
      level: "ok",
      detail: `data directory is writable: ${dbPath}`,
    };
  } catch {
    return {
      id: "local-db",
      label: "local db",
      level: "fail",
      detail: `data directory is not writable: ${dir}`,
      fix: `check permissions on ${dir}`,
    };
  }
}

function coderChecks(
  which: (command: string) => string | null,
): PreflightCheck[] {
  return detectCoderClis({ which }).map(({ spec, path: found }) =>
    found
      ? {
          id: `coder:${spec.id}`,
          label: `coder ${spec.id}`,
          level: "ok",
          detail: found,
        }
      : {
          id: `coder:${spec.id}`,
          label: `coder ${spec.id}`,
          level: "warn",
          detail: `not installed — optional (${spec.purpose})`,
          fix: spec.install.join(" "),
        },
  );
}

export function detectCoderClis(
  options: { which?: (command: string) => string | null } = {},
): CoderDetection[] {
  const which = options.which ?? commandOnPath;
  return CODER_SPECS.map((spec) => ({
    spec,
    path: which(spec.binary),
  }));
}

export function installCoderClis(
  detections: CoderDetection[],
  install: (
    command: string,
    args: string[],
  ) => { ok: boolean; output?: string } = installCommand,
): CoderInstallResult[] {
  return detections
    .filter((detection) => !detection.path)
    .map(({ spec }) => {
      const [command = "npm", ...args] = spec.install;
      const result = install(command, args);
      return {
        id: spec.id,
        command: spec.install.join(" "),
        ok: result.ok,
        ...(result.output ? { output: result.output } : {}),
      };
    });
}

function installCommand(
  command: string,
  args: string[],
): { ok: boolean; output?: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  const output =
    `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() ||
    result.error?.message ||
    "";
  return {
    ok: result.status === 0,
    ...(output ? { output: output.split(/\r?\n/).slice(-12).join("\n") } : {}),
  };
}

export function dockerInstall(): string {
  if (process.platform === "win32") {
    return "winget install -e --id Docker.DockerDesktop";
  }
  if (process.platform === "darwin") {
    return "brew install --cask docker";
  }
  return "https://docs.docker.com/engine/install/";
}

function nodeInstall(): string {
  if (process.platform === "win32") {
    return "winget install OpenJS.NodeJS.LTS";
  }
  if (process.platform === "darwin") {
    return "brew install node@24";
  }
  return "https://nodejs.org/en/download";
}

function commandOnPath(command: string): string | null {
  const probe = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    [command],
    { encoding: "utf8", windowsHide: true },
  );
  if (probe.status !== 0) {
    return null;
  }
  return (
    (probe.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function runCommand(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      return null;
    }
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`
      .trim()
      .split(/\r?\n/)[0];
    return text || null;
  } catch {
    return null;
  }
}

function isPortOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}
