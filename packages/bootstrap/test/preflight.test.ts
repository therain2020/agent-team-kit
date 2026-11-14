import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPreflight,
  detectCoderClis,
  installCoderClis,
  resolveRuntimeMode,
} from "../src/index";

const dirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-preflight-"));
  dirs.push(dir);
  return dir;
}

const idleProbes = {
  includeToolchain: false,
  run: () => null,
  which: () => null,
  portOpen: async () => false,
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("resolveRuntimeMode", () => {
  it("follows env flags and defaults to scale", () => {
    expect(resolveRuntimeMode({})).toBe("scale");
    expect(resolveRuntimeMode({ KIT_RUNTIME_MODE: "local" })).toBe("local");
    expect(resolveRuntimeMode({ KIT_DB_DRIVER: "sqlite" })).toBe("local");
    expect(resolveRuntimeMode({ KIT_DB_DRIVER: "postgres" })).toBe("scale");
    expect(resolveRuntimeMode({ KIT_DB_URL: "postgres://x" })).toBe("scale");
  });
});

describe("collectPreflight", () => {
  it("reports missing scale dependencies with copyable fixes", async () => {
    const home = await tempHome();
    const report = await collectPreflight({
      ...idleProbes,
      env: { KIT_HOME: home, DEEPSEEK_API_KEY: "sk-test" },
      mode: "scale",
      probeResult: {
        ok: true,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        latencyMs: 12,
      },
    });

    expect(report.mode).toBe("scale");
    expect(report.ok).toBe(false);
    const docker = report.checks.find((check) => check.id === "docker");
    expect(docker?.level).toBe("fail");
    expect(docker?.fix).toBeTruthy();
    for (const id of ["service:postgres", "service:nats", "service:temporal"]) {
      const check = report.checks.find((item) => item.id === id);
      expect(check?.level).toBe("warn");
      expect(check?.fix).toBe("kit up");
    }
    expect(report.actions.filter((action) => action === "kit up")).toHaveLength(
      1,
    );
  });

  it("does not require Docker or service ports in local mode", async () => {
    const home = await tempHome();
    const report = await collectPreflight({
      ...idleProbes,
      env: { KIT_HOME: home, DEEPSEEK_API_KEY: "sk-test" },
      mode: "local",
      portOpen: async () => {
        throw new Error("local mode must not probe service ports");
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.id.startsWith("service:"))).toBe(
      false,
    );
    expect(
      report.checks.find((check) => check.id === "docker")?.level,
    ).not.toBe("fail");
    expect(report.checks.find((check) => check.id === "model")?.level).toBe(
      "info",
    );
    expect(report.checks.find((check) => check.id === "local-db")?.level).toBe(
      "info",
    );
  });

  it("surfaces model probe failures without the key", async () => {
    const home = await tempHome();
    const report = await collectPreflight({
      ...idleProbes,
      env: { KIT_HOME: home, DEEPSEEK_API_KEY: "sk-secret-123" },
      mode: "local",
      probe: true,
      probeModel: async () => ({
        ok: false,
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        latencyMs: 5,
        error: { kind: "auth", message: "probe failed: 401 <redacted>" },
      }),
    });

    const model = report.checks.find((check) => check.id === "model");
    expect(model?.level).toBe("fail");
    expect(model?.detail).toContain("auth");
    expect(model?.detail).not.toContain("sk-secret-123");
    expect(model?.fix).toBe("kit bootstrap --key <new-key>");
    expect(report.ok).toBe(false);
  });

  it("lists missing coder CLIs with install commands", async () => {
    const home = await tempHome();
    const report = await collectPreflight({
      ...idleProbes,
      env: { KIT_HOME: home, DEEPSEEK_API_KEY: "sk-test" },
      mode: "local",
      which: (command) => (command === "codex" ? "C:\\bin\\codex.exe" : null),
    });

    const codex = report.checks.find((check) => check.id === "coder:codex");
    expect(codex?.level).toBe("ok");
    const dsh = report.checks.find((check) => check.id === "coder:dsh");
    expect(dsh?.level).toBe("warn");
    expect(dsh?.fix).toBe("npm install -g @deepseek-ai/dsh");
  });
});

describe("coder installs", () => {
  it("only installs missing coders and uses the spec command", () => {
    const detections = detectCoderClis({
      which: (command) => (command === "codex" ? "codex.exe" : null),
    });
    const calls: string[] = [];
    const results = installCoderClis(detections, (command, args) => {
      calls.push([command, ...args].join(" "));
      return { ok: true };
    });

    expect(results.map((result) => result.id)).toEqual([
      "dsh",
      "opencode",
      "pi",
    ]);
    expect(calls).toContain(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    );
    expect(calls.some((call) => call.includes("@openai/codex"))).toBe(false);
  });
});
