import { spawnSync } from "node:child_process";
import net from "node:net";
import { loadApiKey } from "@kit/bootstrap";
import type { Command } from "commander";

type Level = "ok" | "warn" | "fail" | "info";

interface Check {
  level: Level;
  label: string;
  detail: string;
}

const PORTS: Record<number, string> = {
  5432: "Postgres",
  4222: "NATS",
  7233: "Temporal",
  3000: "console",
};

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check the local toolchain, services and model key")
    .option("--json", "machine-readable output", false)
    .action(async (options: { json: boolean }) => {
      const checks = await collectChecks();
      if (options.json) {
        console.log(JSON.stringify(checks, null, 2));
      } else {
        console.log("Agent Team Kit doctor\n");
        for (const check of checks) {
          console.log(
            `${symbol(check.level)} ${check.label.padEnd(16)} ${check.detail}`,
          );
        }
        console.log("\nDocs: docs/install.md");
      }
      if (checks.some((check) => check.level === "fail")) {
        process.exitCode = 1;
      }
    });
}

async function collectChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const bun = (process.versions as Record<string, string | undefined>).bun;
  checks.push(
    bun
      ? { level: "ok", label: "bun", detail: bun }
      : { level: "fail", label: "bun", detail: "not running under Bun" },
  );

  const node = run("node", ["--version"]);
  if (!node) {
    checks.push({
      level: "fail",
      label: "node",
      detail: "not found — Node 24+ is required for the Temporal worker",
    });
  } else {
    const major = Number(node.replace(/^v/, "").split(".")[0]);
    checks.push(
      major >= 24
        ? { level: "ok", label: "node", detail: node }
        : {
            level: "warn",
            label: "node",
            detail: `${node} — Node 24+ is required for the Temporal worker`,
          },
    );
  }

  const docker = run("docker", ["--version"]);
  checks.push(
    docker
      ? { level: "ok", label: "docker", detail: docker }
      : {
          level: "fail",
          label: "docker",
          detail:
            "not found — install Docker Desktop, or reuse an existing stack with --no-infra",
        },
  );

  const compose = docker ? run("docker", ["compose", "version"]) : null;
  checks.push(
    compose
      ? { level: "ok", label: "docker compose", detail: compose }
      : {
          level: "warn",
          label: "docker compose",
          detail: "not available — compose v2 is required by kit up",
        },
  );

  for (const [port, name] of Object.entries(PORTS)) {
    const open = await portOpen(Number(port));
    checks.push(
      open
        ? { level: "ok", label: `port ${port}`, detail: `${name} reachable` }
        : {
            level: "warn",
            label: `port ${port}`,
            detail: `${name} closed — run kit up`,
          },
    );
  }

  const envKey = process.env.DEEPSEEK_API_KEY;
  const storedKey = envKey ? true : Boolean(loadApiKey());
  checks.push(
    storedKey
      ? {
          level: "ok",
          label: "model key",
          detail: envKey
            ? "DEEPSEEK_API_KEY is set"
            : "stored by kit bootstrap",
        }
      : {
          level: "warn",
          label: "model key",
          detail: "missing — run kit bootstrap or open /welcome",
        },
  );

  const coders = ["dsh", "codex", "opencode"].filter((command) =>
    Boolean(run(whereCommand(), [command])),
  );
  checks.push({
    level: "info",
    label: "coder CLIs",
    detail:
      coders.length > 0
        ? coders.join(", ")
        : "none found (optional; needed for kit iterate)",
  });

  return checks;
}

function run(command: string, args: string[]): string | null {
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

function whereCommand(): string {
  return process.platform === "win32" ? "where" : "which";
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

function symbol(level: Level): string {
  switch (level) {
    case "ok":
      return "✔";
    case "warn":
      return "⚠";
    case "fail":
      return "✖";
    default:
      return "ℹ";
  }
}
