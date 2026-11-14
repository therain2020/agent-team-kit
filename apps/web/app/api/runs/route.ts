import { existsSync } from "node:fs";
import path from "node:path";
import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { getStore } from "@/lib/store";
import { eventEnvelopeSchema, newId } from "@kit/core";
import { buildPackRun, loadPack } from "@kit/pack";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    packDir?: unknown;
    workflow?: unknown;
    stub?: unknown;
    evidenceArtifactId?: unknown;
    evidenceText?: unknown;
    mode?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.mode !== undefined && body.mode !== "DRY_RUN") {
    return NextResponse.json(
      { error: "only DRY_RUN is supported from the console" },
      { status: 400 },
    );
  }
  if (typeof body.packDir !== "string" || body.packDir.trim().length === 0) {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }

  const packInput = body.packDir
    .trim()
    .replace(/^[./\\]+/, "")
    .replace(/^packs[\\/]/, "");
  const packDir = resolvePackDir(packInput);
  if (!packDir) {
    return NextResponse.json(
      { error: "packDir must be inside packs/" },
      { status: 400 },
    );
  }
  if (!existsSync(path.join(packDir, "team.yaml"))) {
    return NextResponse.json(
      { error: "team.yaml not found in packDir" },
      { status: 404 },
    );
  }

  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: "invalid pack", details: loaded.errors },
      { status: 400 },
    );
  }

  const store = await getStore();
  let evidenceText: string | undefined;
  if (body.evidenceText !== undefined) {
    if (
      typeof body.evidenceText !== "string" ||
      body.evidenceText.length > 200_000
    ) {
      return NextResponse.json(
        { error: "evidenceText must be a string under 200k characters" },
        { status: 400 },
      );
    }
    evidenceText = body.evidenceText.trim() || undefined;
  }
  if (!evidenceText && body.evidenceArtifactId !== undefined) {
    if (typeof body.evidenceArtifactId !== "string") {
      return NextResponse.json(
        { error: "evidenceArtifactId must be a string" },
        { status: 400 },
      );
    }
    const artifact = await store.artifactStore.findById(
      body.evidenceArtifactId,
    );
    if (!artifact) {
      return NextResponse.json(
        { error: "evidence artifact not found" },
        { status: 404 },
      );
    }
    const blob = await store.blobs.findById(artifact.blobId);
    if (!blob) {
      return NextResponse.json(
        { error: "evidence blob not found" },
        { status: 404 },
      );
    }
    try {
      const bytes = await store.blobClient.get(blob.storageKey);
      evidenceText = new TextDecoder().decode(bytes);
    } catch {
      return NextResponse.json(
        { error: "evidence content unavailable in this blob backend" },
        { status: 409 },
      );
    }
  }

  let built: Awaited<ReturnType<typeof buildPackRun>>;
  try {
    built = await buildPackRun(loaded, {
      workflow: typeof body.workflow === "string" ? body.workflow : undefined,
      stub: body.stub === true,
      input: evidenceText,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "failed to build run",
      },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const event = eventEnvelopeSchema.parse({
    eventId: built.input.eventId,
    type: built.eventType,
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: built.input.workspaceId,
    idempotencyKey: `ui:${built.input.runId}`,
    traceId: newId("trc"),
    payloadRef: "memory://ui",
  });
  await store.events.insert(event);

  const { client, connection } = await createTemporalClient();
  try {
    const handle = await client.workflow.start("packWorkflow", {
      taskQueue,
      workflowId: `pack-${built.input.runId}`,
      args: [built.input],
    });
    return NextResponse.json(
      {
        runId: built.input.runId,
        workflowId: handle.workflowId,
        pack: loaded.pack.metadata.name,
        workflow: built.workflow.id,
        stub: built.input.stub,
        evidence: Boolean(evidenceText),
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "failed to start workflow",
        runId: built.input.runId,
      },
      { status: 502 },
    );
  } finally {
    await connection.close();
  }
}
