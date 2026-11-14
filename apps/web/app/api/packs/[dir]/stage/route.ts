import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { type StageFieldsUpdate, updateStageFields } from "@kit/pack";
import { NextResponse } from "next/server";

const TEXT_FIELDS = [
  "agent",
  "coder",
  "goal",
  "acceptance",
  "timeout",
  "gate",
  "inputFrom",
  "revisionAgent",
  "failureMode",
] as const;

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

  let body: {
    file?: unknown;
    stageId?: unknown;
    fields?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (
    typeof body.file !== "string" ||
    typeof body.stageId !== "string" ||
    typeof body.fields !== "object" ||
    body.fields === null
  ) {
    return NextResponse.json(
      { error: "file, stageId and fields are required" },
      { status: 400 },
    );
  }

  const raw = body.fields as Record<string, unknown>;
  const fields: StageFieldsUpdate = {
    ...("type" in raw ? { type: asType(raw.type) } : {}),
    ...textFields(raw),
    ...("inputs" in raw ? { inputs: asList(raw.inputs) } : {}),
    ...("outputs" in raw ? { outputs: asList(raw.outputs) } : {}),
    ...("inputsFrom" in raw ? { inputsFrom: asList(raw.inputsFrom) } : {}),
    ...("retry" in raw ? { retry: asRetry(raw.retry) } : {}),
    ...("includeInitialInput" in raw
      ? {
          includeInitialInput:
            raw.includeInitialInput === null
              ? null
              : raw.includeInitialInput === true,
        }
      : {}),
  };

  try {
    await updateStageFields(packDir, body.file, body.stageId, fields);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "save failed" },
      { status: 400 },
    );
  }
}

function asType(value: unknown): StageFieldsUpdate["type"] {
  if (
    value === "workflow" ||
    value === "agent" ||
    value === "coder" ||
    value === null
  ) {
    return value;
  }
  return undefined;
}

function textFields(raw: Record<string, unknown>): Partial<StageFieldsUpdate> {
  const out: Record<string, string | null | undefined> = {};
  for (const key of TEXT_FIELDS) {
    if (!(key in raw)) {
      continue;
    }
    const value = raw[key];
    if (typeof value === "string" || value === null) {
      out[key] = value;
    }
  }
  return out as Partial<StageFieldsUpdate>;
}

function asList(value: unknown): string[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRetry(value: unknown): StageFieldsUpdate["retry"] {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as { max?: unknown; backoff?: unknown };
  if (typeof record.max !== "number") {
    return undefined;
  }
  const backoff = record.backoff === "exp" ? "exp" : "fixed";
  return { max: record.max, backoff };
}
