import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { writeAutopilotFile } from "@kit/pack";
import { NextResponse } from "next/server";
import { parse, stringify } from "yaml";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }
  const { dir } = await params;
  const packDir = resolvePackDir(decodeURIComponent(dir));
  if (!packDir) {
    return NextResponse.json({ error: "invalid pack" }, { status: 400 });
  }

  let body: { content?: unknown; config?: unknown; confirmRisk?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let content: string;
  if (typeof body.content === "string") {
    if (body.content.length > 64 * 1024) {
      return NextResponse.json(
        { error: "content exceeds 64KB" },
        { status: 400 },
      );
    }
    content = body.content;
  } else if (body.config && typeof body.config === "object") {
    content = stringify(body.config);
  } else {
    return NextResponse.json(
      { error: "content or config is required" },
      { status: 400 },
    );
  }

  const risk = reviewRisk(content);
  if (risk.error) {
    return NextResponse.json({ error: risk.error }, { status: 400 });
  }
  if (risk.risky && body.confirmRisk !== true) {
    return NextResponse.json(
      {
        error:
          "enabling the daemon, LIVE schedules or auto-approval requires explicit confirmation",
        code: "confirmation_required",
      },
      { status: 400 },
    );
  }

  try {
    const config = await writeAutopilotFile(packDir, content);
    return NextResponse.json({ ok: true, config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}

function reviewRisk(content: string): { risky: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return { risky: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { risky: false };
  }
  const doc = parsed as Record<string, unknown>;
  const autoApprove = (
    doc.approval as { autoApprove?: { enabled?: unknown; maxRisk?: unknown } }
  )?.autoApprove;
  if (autoApprove?.enabled === true && autoApprove.maxRisk === "high") {
    return {
      risky: true,
      error: "high-risk changes always need human approval",
    };
  }
  const schedules = Array.isArray(doc.schedules) ? doc.schedules : [];
  const risky =
    doc.enabled === true ||
    autoApprove?.enabled === true ||
    schedules.some(
      (schedule) => (schedule as { mode?: unknown } | null)?.mode === "LIVE",
    );
  return { risky };
}
