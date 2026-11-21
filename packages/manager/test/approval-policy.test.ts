import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunOriginKind } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AutoApprovalPolicy,
  type AutoApprovalSignalInput,
  evaluateAutoApproval,
  findDecisionForRequest,
  runAutoApprovalPass,
} from "../src/index";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-policy-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

const NOW = new Date("2026-11-21T12:00:00.000Z");

function policy(
  overrides: Partial<AutoApprovalPolicy> = {},
): AutoApprovalPolicy {
  return {
    policyId: "tech-radar:auto-approve",
    enabled: true,
    scope: "scheduled",
    maxRisk: "low",
    onTimeout: "wait",
    ...overrides,
  };
}

async function pausedRun(
  store: Awaited<ReturnType<typeof initStore>>,
  input: {
    runId: string;
    originKind: RunOriginKind;
    triggerId?: string;
    riskClass?: "low" | "medium" | "high";
    requestType?: "stage_before" | "budget_exceeded";
    expiresAt?: string;
    costCny?: number;
  },
): Promise<{ requestId: string }> {
  const now = NOW.toISOString();
  const eventId = `evt_${input.runId}`;
  await store.events.insert({
    eventId,
    type: "run.requested",
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: "default",
    idempotencyKey: `test:${input.runId}`,
    traceId: `trc_${input.runId}`,
    payloadRef: "memory://test",
  });
  await store.runs.create({
    runId: input.runId,
    eventId,
    workspaceId: "default",
    workflowId: "daily-radar",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "paused",
    originKind: input.originKind,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    createdAt: now,
    updatedAt: now,
  });

  const requestId = `apr_${input.runId}`;
  const request = {
    requestId,
    runId: input.runId,
    stageId: `${input.runId}:draft`,
    stageName: "draft",
    requestType: input.requestType ?? "stage_before",
    draftArtifactId: null,
    draftVersion: 1,
    summary: "review the draft",
    options: ["approve", "abort"],
    riskClass: input.riskClass ?? "low",
    gateRefs: [],
    requestedBy: "manager",
    expiresAt: input.expiresAt ?? "2026-11-21T13:00:00.000Z",
  };
  const published = await store.artifactService.publish({
    workspaceId: "default",
    content: new TextEncoder().encode(JSON.stringify(request, null, 2)),
    producer: {
      agentId: "manager",
      agentVersion: "1.0.0",
      promptHash: "sha256:test-approval",
      modelId: "none",
    },
    inputs: [],
    runId: input.runId,
    stageId: `${input.runId}:draft:approval-request`,
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: input.costCny ?? 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  await store.approvals.enqueue({
    approvalId: requestId,
    workspaceId: "default",
    runId: input.runId,
    stageId: `${input.runId}:draft`,
    kind: request.requestType,
    requester: "manager",
    payloadRef: published.artifact.artifactId,
    expiresAt: request.expiresAt,
  });
  return { requestId };
}

function captureSignals() {
  const signals: AutoApprovalSignalInput[] = [];
  return {
    signals,
    signal: async (input: AutoApprovalSignalInput) => {
      signals.push(input);
    },
  };
}

describe("auto-approval policy", () => {
  it("does not approve manual jobs under the default scope", async () => {
    const store = await setup();
    await pausedRun(store, {
      runId: "run_manual_default",
      originKind: "manual",
      triggerId: "manual:alice",
    });
    const capture = captureSignals();

    const result = await runAutoApprovalPass({
      store,
      workspaceId: "default",
      now: NOW,
      packs: [
        {
          packDir: "tech-radar",
          workflowIds: ["daily-radar"],
          policy: policy(),
        },
      ],
      signal: capture.signal,
    });

    expect(result.approved).toEqual([]);
    expect(capture.signals).toEqual([]);
    const record = await store.approvals.getByRun("run_manual_default");
    expect(record?.status).toBe("queued");
    expect(await store.decisions.list({ runId: "run_manual_default" })).toEqual(
      [],
    );
  });

  it("covers manual jobs only when scope is explicitly all", async () => {
    const store = await setup();
    const { requestId } = await pausedRun(store, {
      runId: "run_manual_all",
      originKind: "manual",
      triggerId: "manual:alice",
    });
    const capture = captureSignals();

    const result = await runAutoApprovalPass({
      store,
      workspaceId: "default",
      now: NOW,
      packs: [
        {
          packDir: "tech-radar",
          workflowIds: ["daily-radar"],
          policy: policy({ scope: "all" }),
        },
      ],
      signal: capture.signal,
    });

    expect(result.approved).toEqual(["run_manual_all"]);
    expect(capture.signals).toEqual([
      {
        runId: "run_manual_all",
        requestId,
        decision: "approve",
        rationale: expect.stringContaining("scope all"),
      },
    ]);
    expect((await store.approvals.get(requestId))?.status).toBe("approved");
  });

  it("records policyId, scope, triggerId, runId, requestId and rationale", async () => {
    const store = await setup();
    const { requestId } = await pausedRun(store, {
      runId: "run_schedule_trace",
      originKind: "schedule",
      triggerId: "daily-radar",
      costCny: 0.25,
    });
    const capture = captureSignals();

    await runAutoApprovalPass({
      store,
      workspaceId: "default",
      now: NOW,
      packs: [
        {
          packDir: "tech-radar",
          workflowIds: ["daily-radar"],
          policy: policy(),
        },
      ],
      signal: capture.signal,
    });

    const decision = await findDecisionForRequest(
      store,
      "run_schedule_trace",
      requestId,
    );
    expect(decision).toMatchObject({
      runId: "run_schedule_trace",
      requestId,
      option: "approve",
      decidedBy: "policy:autopilot",
      policyId: "tech-radar:auto-approve",
      scope: "scheduled",
      triggerId: "daily-radar",
      rationale: expect.stringContaining("tech-radar:auto-approve"),
    });
    expect(decision?.decisionId).toMatch(/^dec_/);
  });

  it("skips budget exceptions and risk/cost over the ceilings", async () => {
    const store = await setup();
    await pausedRun(store, {
      runId: "run_budget",
      originKind: "schedule",
      requestType: "budget_exceeded",
    });
    await pausedRun(store, {
      runId: "run_high_risk",
      originKind: "schedule",
      riskClass: "high",
    });
    await pausedRun(store, {
      runId: "run_costly",
      originKind: "schedule",
      costCny: 5,
    });
    const capture = captureSignals();

    const result = await runAutoApprovalPass({
      store,
      workspaceId: "default",
      now: NOW,
      packs: [
        {
          packDir: "tech-radar",
          workflowIds: ["daily-radar"],
          policy: policy({ maxRunCostCny: 1 }),
        },
      ],
      signal: capture.signal,
    });

    expect(result.approved).toEqual([]);
    expect(capture.signals).toEqual([]);
  });

  it("aborts expired approvals only when the policy says so", async () => {
    const expensive = evaluateAutoApproval(
      {
        runId: "run_expired",
        requestId: "apr_expired",
        originKind: "schedule",
        requestType: "stage_before",
        riskClass: "low",
        costCny: 0,
        expiresAt: "2026-11-21T11:00:00.000Z",
      },
      policy({ onTimeout: "abort" }),
      NOW,
    );
    expect(expensive.decision).toBe("abort");

    const waited = evaluateAutoApproval(
      {
        runId: "run_expired",
        requestId: "apr_expired",
        originKind: "schedule",
        requestType: "stage_before",
        riskClass: "low",
        costCny: 0,
        expiresAt: "2026-11-21T11:00:00.000Z",
      },
      policy({ onTimeout: "wait" }),
      NOW,
    );
    expect(waited.decision).toBe("skip");
  });
});
