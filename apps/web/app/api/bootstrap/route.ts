import { sameOriginError } from "@/lib/http";
import {
  hasApiKey,
  probeModel,
  readBootstrapProfileSync,
  resolveRuntimeMode,
  saveApiKey,
  writeBootstrapProfile,
} from "@kit/bootstrap";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const profile = readBootstrapProfileSync();
  return NextResponse.json({
    configured: Boolean(profile),
    hasKey: hasApiKey(),
    profile,
  });
}

export async function POST(request: Request) {
  if (sameOriginError(request)) {
    return NextResponse.json({ error: "invalid origin" }, { status: 403 });
  }

  let body: {
    apiKey?: unknown;
    baseUrl?: unknown;
    flash?: unknown;
    pro?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (apiKey.length > 512) {
    return NextResponse.json({ error: "apiKey is too long" }, { status: 400 });
  }

  const baseUrl =
    typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim().replace(/\/$/, "")
      : (readBootstrapProfileSync()?.baseUrl ?? "https://api.deepseek.com");
  if (!isHttpUrl(baseUrl)) {
    return NextResponse.json(
      { error: "baseUrl must be an http(s) URL" },
      { status: 400 },
    );
  }

  const flash =
    typeof body.flash === "string" && body.flash.trim()
      ? body.flash.trim()
      : (readBootstrapProfileSync()?.models.flash ?? "deepseek-flash");
  const pro =
    typeof body.pro === "string" && body.pro.trim()
      ? body.pro.trim()
      : (readBootstrapProfileSync()?.models.pro ?? "deepseek-v4-pro");

  const probe = await probeModel({ apiKey, baseUrl, model: flash });
  if (!probe.ok) {
    return NextResponse.json(
      {
        ok: false,
        probe: {
          latencyMs: probe.latencyMs,
          error: probe.error ?? { kind: "unknown", message: "probe failed" },
        },
      },
      { status: 400 },
    );
  }

  const saved = await saveApiKey(apiKey);
  const profile = {
    apiVersion: "agentteam/v1" as const,
    mode: resolveRuntimeMode(process.env),
    baseUrl,
    models: { flash, pro },
    workspaceId: "default",
    createdAt: new Date().toISOString(),
  };
  await writeBootstrapProfile(profile);

  return NextResponse.json({
    ok: true,
    profile,
    keyBackend: saved.backend,
    probe: {
      latencyMs: probe.latencyMs,
      ...(probe.models ? { models: probe.models } : {}),
    },
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
