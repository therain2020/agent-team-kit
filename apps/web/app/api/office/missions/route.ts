import { sameOriginError } from "@/lib/http";
import { resolvePackDir } from "@/lib/paths";
import { getStore } from "@/lib/store";
import { eventEnvelopeSchema, missionAssignmentSchema, newId } from "@kit/core";
import {
  buildPackRun,
  loadPack,
  planAgents,
  rolePlanForAgents,
  validateRolePlan,
} from "@kit/pack";
import { createTemporalClient, taskQueue } from "@kit/workflow";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export async function POST(request: Request) {
  const originError = sameOriginError(request);
  if (originError) {
    return NextResponse.json({ error: originError }, { status: 403 });
  }

  let body: {
    packDir?: unknown;
    workflow?: unknown;
    manager?: unknown;
    agents?: unknown;
    sellers?: unknown;
    builders?: unknown;
    specialists?: unknown;
    allowCombined?: unknown;
    goal?: unknown;
    acceptance?: unknown;
    evidenceText?: unknown;
    stub?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.packDir !== "string") {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  const packDir = resolvePackDir(body.packDir.replace(/^packs[\\/]/, ""));
  if (!packDir) {
    return NextResponse.json(
      { error: "packDir must be inside packs/" },
      { status: 400 },
    );
  }
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: "invalid pack", details: loaded.errors },
      { status: 400 },
    );
  }

  const workflowId =
    typeof body.workflow === "string" ? body.workflow : loaded.workflows[0]?.id;
  if (!workflowId) {
    return NextResponse.json(
      { error: "workflow is required" },
      { status: 400 },
    );
  }
  if (!loaded.workflows.some((workflow) => workflow.id === workflowId)) {
    return NextResponse.json(
      { error: `unknown workflow: ${workflowId}` },
      { status: 400 },
    );
  }

  const manager =
    typeof body.manager === "string" && body.manager.trim()
      ? body.manager.trim()
      : "manager";
  const managerValid =
    manager === "manager" ||
    loaded.agents.has(manager) ||
    Boolean(loaded.pack.manager?.agent);
  if (!managerValid) {
    return NextResponse.json({ error: "invalid manager" }, { status: 400 });
  }

  const selectedAgents = Array.isArray(body.agents)
    ? body.agents.filter((agent): agent is string => typeof agent === "string")
    : [];
  const requestedSellers = stringList(body.sellers);
  const requestedBuilders = stringList(body.builders);
  const requestedSpecialists = stringList(body.specialists);
  const allowCombined = loaded.roleRules.allowCombined;

  let rolePlan =
    requestedSellers.length + requestedBuilders.length > 0
      ? {
          sellers: requestedSellers,
          builders: requestedBuilders,
          specialists: requestedSpecialists,
          allowCombined,
        }
      : rolePlanForAgents(loaded.agents, allowCombined);

  if (selectedAgents.length > 0) {
    const selected = new Set(selectedAgents);
    rolePlan = {
      sellers: rolePlan.sellers.filter((id) => selected.has(id)),
      builders: rolePlan.builders.filter((id) => selected.has(id)),
      specialists: rolePlan.specialists.filter((id) => selected.has(id)),
      allowCombined,
    };
  }

  if (
    rolePlan.sellers.length === 0 &&
    rolePlan.builders.length === 0 &&
    rolePlan.specialists.length === 0
  ) {
    rolePlan = rolePlanForAgents(loaded.agents, allowCombined);
  }

  const roleErrors = validateRolePlan({
    agents: loaded.agents,
    rules: loaded.roleRules,
    sellers: rolePlan.sellers,
    builders: rolePlan.builders,
    specialists: rolePlan.specialists,
    allowCombined,
  });
  if (roleErrors.length > 0) {
    return NextResponse.json(
      { error: "invalid role assignment", details: roleErrors },
      { status: 400 },
    );
  }

  const agents = planAgents(rolePlan);
  if (agents.length === 0) {
    return NextResponse.json({ error: "no agents assigned" }, { status: 400 });
  }

  const goal =
    typeof body.goal === "string" && body.goal.trim()
      ? body.goal.trim().slice(0, 20_000)
      : `Run ${workflowId}`;
  const acceptance =
    typeof body.acceptance === "string" && body.acceptance.trim()
      ? body.acceptance.trim().slice(0, 20_000)
      : undefined;
  const evidenceText =
    typeof body.evidenceText === "string" && body.evidenceText.trim()
      ? body.evidenceText.slice(0, 200_000)
      : undefined;

  let built: Awaited<ReturnType<typeof buildPackRun>>;
  try {
    built = await buildPackRun(loaded, {
      workflow: workflowId,
      input: evidenceText ?? goal,
      stub: body.stub === true,
      runMode: "DRY_RUN",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed to build run" },
      { status: 400 },
    );
  }

  const store = await getStore();
  const now = new Date().toISOString();
  const event = eventEnvelopeSchema.parse({
    eventId: built.input.eventId,
    type: built.eventType,
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: built.input.workspaceId,
    idempotencyKey: `mission:${built.input.runId}`,
    traceId: newId("trc"),
    payloadRef: "memory://office",
  });
  await store.events.insert(event);

  const mission = missionAssignmentSchema.parse({
    goal,
    acceptance,
    packDir: loaded.pack.metadata.name,
    workflow: workflowId,
    manager,
    sellers: rolePlan.sellers,
    builders: rolePlan.builders,
    specialists: rolePlan.specialists,
    agents,
    allowCombined,
    mode: "DRY_RUN",
    createdAt: now,
    createdBy: "operator:office",
  });
  await store.artifactService.publish({
    workspaceId: built.input.workspaceId,
    content: new TextEncoder().encode(JSON.stringify(mission, null, 2)),
    producer: {
      agentId: "manager",
      agentVersion: "1.0.0",
      promptHash: "sha256:mission-assignment",
      modelId: "none",
    },
    inputs: [],
    runId: built.input.runId,
    stageId: `${built.input.runId}:mission-assignment`,
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

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
        workflow: workflowId,
        mission,
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
