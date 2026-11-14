import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadApiKey,
  loadModelDefaults,
  probeModel,
  readBootstrapProfileSync,
  saveApiKey,
  writeBootstrapProfile,
} from "../src/index";

const dirs: string[] = [];

async function tempHome(): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-bootstrap-"));
  dirs.push(dir);
  return { KIT_HOME: dir };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("bootstrap profile", () => {
  it("writes and reads a profile without the key", async () => {
    const env = await tempHome();
    await writeBootstrapProfile(
      {
        apiVersion: "agentteam/v1",
        mode: "local",
        baseUrl: "https://api.deepseek.com",
        models: { flash: "deepseek-flash", pro: "deepseek-v4-pro" },
        workspaceId: "default",
        createdAt: "2026-11-15T00:00:00.000Z",
      },
      env,
    );

    const profile = readBootstrapProfileSync(env);
    expect(profile?.models.flash).toBe("deepseek-flash");
    expect(profile?.baseUrl).toBe("https://api.deepseek.com");
    expect(loadModelDefaults(env).pro).toBe("deepseek-v4-pro");
  });

  it("returns null when the profile is missing", async () => {
    const env = await tempHome();
    expect(readBootstrapProfileSync(env)).toBeNull();
    expect(loadModelDefaults(env)).toEqual({
      baseUrl: undefined,
      flash: undefined,
      pro: undefined,
    });
  });
});

describe("api key storage", () => {
  it("round-trips a stored key and prefers the env key", async () => {
    const env = await tempHome();
    const saved = await saveApiKey("sk-test-1234567890", env);
    expect(["dpapi", "file"]).toContain(saved.backend);
    expect(loadApiKey(env)).toBe("sk-test-1234567890");
    expect(loadApiKey({ ...env, DEEPSEEK_API_KEY: "sk-env" })).toBe("sk-env");
  });
});

describe("model probe", () => {
  it("returns latency and models on success", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek-flash" }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeModel({
      apiKey: "sk-secret",
      baseUrl: "https://api.example.com",
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["deepseek-flash"]);
    expect(result.reply).toBe("OK");
  });

  it("classifies auth errors and redacts the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("bad key sk-secret-abcdef", { status: 401 }),
      ),
    );
    const result = await probeModel({
      apiKey: "sk-secret-abcdef",
      baseUrl: "https://api.example.com",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("auth");
    expect(result.error?.message).not.toContain("sk-secret-abcdef");
    expect(result.error?.message).toContain("<redacted>");
  });

  it("classifies network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    const result = await probeModel({
      apiKey: "sk-secret",
      baseUrl: "https://api.example.com",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("network");
  });
});
