import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildObserverTimeline } from "@kit/activity";
import {
  type InformationEvent,
  type ReactionRule,
  applyChangeTransition,
  buildInformationEvent,
  newChangeProposal,
  reactionRuleSchema,
} from "@kit/core";
import {
  type InformationEventRecord,
  changeApprovalIdFor,
  initStore,
  loadStoreConfig,
} from "@kit/store";
import {
  type FireTriggerDeps,
  reactToInformationEvent,
  traceReactions,
} from "@kit/trigger";
import { afterEach, describe, expect, it } from "vitest";

const AT = "2026-11-20T10:00:00.000Z";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-reaction-chain-"));
  roots.push(root);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(root, ".kit"),
      KIT_BLOB_ROOT: path.join(root, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return { root, store };
}

function informationEventRecord(): InformationEventRecord {
  const payload = buildInformationEvent({
    workspaceId: "default",
    type: "information.item",
    sourceId: "arxiv",
    captureKey: "capture-chain",
    itemRef: "item-chain",
    contentRef: "ref-chain",
    fetchedAt: AT,
    eventId: "inf_chain",
    entities: ["OpenAI"],
    claims: [
      {
        claimId: "claim-chain",
        text: "OpenAI released a new agent SDK",
        entities: ["OpenAI"],
        provenance: [
          {
            captureKey: "capture-chain",
            sourceId: "arxiv",
            contentRef: "ref-chain",
            fetchedAt: AT,
          },
        ],
      },
    ],
    signals: {
      relevance: 0.9,
      novelty: 0.8,
      urgency: 0.7,
      risk: 0.1,
      confidence: 0.8,
      reasons: ["chain test"],
      model: "heuristic",
      profileVersion: 1,
      flags: [],
    },
  });
  return recordFrom(payload);
}

function recordFrom(event: InformationEvent): InformationEventRecord {
  return {
    eventId: event.eventId,
    eventType: event.type,
    workspaceId: event.workspaceId,
    sourceId: event.sourceId,
    sourceKind: event.sourceKind,
    captureKey: event.captureKey,
    dedupeKey: event.dedupeKey,
    itemRef: event.itemRefs[0] ?? event.eventId,
    url: "https://example.com/chain",
    title: "New agent SDK",
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sensitivity: event.sensitivity,
    payload: event,
    createdAt: event.receivedAt,
  };
}

function chainRule(): ReactionRule {
  return reactionRuleSchema.parse({
    ruleId: "rr_chain",
    workspaceId: "default",
    name: "chain",
    enabled: true,
    match: {
      eventType: "information.*",
      topics: ["agent"],
      entities: ["OpenAI"],
      minSignals: { relevance: 0.5 },
    },
    target: {
      packDir: "packs/tech-radar",
      jobKind: "iteration",
      goal: "answer the reaction chain",
    },
    missionTemplate: "React to {title}",
    runMode: "DRY_RUN",
    approval: { autoApprove: true, maxRisk: "low" },
    priority: 0,
    version: 1,
    source: "human",
    rationale: "chain e2e",
  });
}

describe("reaction chain", () => {
  it("answers event → rule → job → artifact → decision → rollback from one event", async () => {
    const { root, store } = await setup();
    const event = informationEventRecord();
    await store.information.appendEvent({
      event: event.payload,
      workspaceId: "default",
      title: event.title,
      url: event.url,
    });

    const iterationId = "it_chain";
    const artifact = await store.artifactService.publish({
      workspaceId: "default",
      content: new TextEncoder().encode("chain artifact"),
      producer: {
        agentId: "coder",
        agentVersion: "0.9.0",
        promptHash: "chain",
        modelId: "none",
      },
      inputs: [],
      runId: iterationId,
      stageId: `${iterationId}:result`,
      runMode: "DRY_RUN",
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
    const artifactId = artifact.artifact.artifactId;

    await store.sql`
      INSERT INTO iteration_runs (
        iteration_id, workspace_id, goal, run_mode, apply_mode, status, phase,
        started_at, updated_at
      ) VALUES (
        ${iterationId}, ${"default"}, ${"answer the reaction chain"},
        ${"DRY_RUN"}, ${"none"}, ${"succeeded"}, ${"done"}, ${AT}, ${AT}
      )
    `;
    await store.sql`
      INSERT INTO iteration_tasks (
        iteration_id, task_id, domain, goal, acceptance, status, phase,
        risk, result_artifact_id, started_at, updated_at
      ) VALUES (
        ${iterationId}, ${"task-1"}, ${"docs"}, ${"write the chain answer"},
        ${"six segments resolve"}, ${"succeeded"}, ${"done"}, ${"low"},
        ${artifactId}, ${AT}, ${AT}
      )
    `;

    // High-risk proposal → queued approval → decided approval. This is the
    // real ChangeApprovalService path, not a fixture of the resolver.
    const proposalId = "chg_chain";
    let proposal = newChangeProposal({
      id: proposalId,
      workspaceId: "default",
      substrate: "code",
      producer: "iterate",
      hypothesis: "keep the chain answerable",
      acceptance: ["all six segments resolve from one event"],
      risk: "high",
      revertRef: "commit:abc123",
      revert: {
        kind: "code",
        commit: "abc123",
        baseSha: null,
        backupDir: null,
      },
      sourceRef: { kind: "iteration", id: iterationId, taskId: "task-1" },
      actor: "iterate:chain",
      now: AT,
    });
    proposal = applyChangeTransition(proposal, {
      trigger: "evaluate",
      actor: "iterate:chain",
      at: AT,
    });
    proposal = applyChangeTransition(proposal, {
      trigger: "evaluation_passed",
      actor: "iterate:chain",
      at: AT,
    });
    await store.changeProposals.create(proposal);
    const requested = await store.changeApprovals.request(proposalId, {
      now: AT,
    });
    expect(requested?.changeId).toBe(proposalId);
    const decided = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor(proposalId),
      status: "approved",
      decisionBy: "operator:test",
      reason: "reviewed the high-risk code change",
      at: AT,
    });
    expect(decided.ok).toBe(true);
    const approvalId = changeApprovalIdFor(proposalId);

    const outcome = await reactToInformationEvent(event, {
      store,
      repoRoot: process.cwd(),
      now: new Date("2026-11-20T12:00:00.000Z"),
      env: {},
      rules: [chainRule()],
      reactionsPath: path.join(root, "signals", "reactions.jsonl"),
      killSwitchFn: (() => null) as unknown as FireTriggerDeps["killSwitchFn"],
      opsGateFn: (async () => ({
        readOnly: false,
        nightMode: false,
        nightException: false,
        reason: null,
        timezone: "UTC",
        action: null,
      })) as unknown as FireTriggerDeps["opsGateFn"],
      startJobFn: (async () => ({
        jobId: iterationId,
        kind: "iteration",
        workflowId: `iteration-${iterationId}`,
        engine: "local",
        runMode: "DRY_RUN",
        pack: "tech-radar",
      })) as unknown as FireTriggerDeps["startJobFn"],
    });
    expect(outcome.candidates[0]?.decision).toBe("fired");

    const trace = await traceReactions({ store }, "default", "inf_chain");
    expect(trace).toHaveLength(1);
    const entry = trace[0];
    expect(entry).toMatchObject({
      ruleId: "rr_chain",
      jobId: iterationId,
      jobKind: "iteration",
      status: "started",
      chainComplete: true,
    });
    expect(entry?.artifacts.map((item) => item.artifactId)).toContain(
      artifactId,
    );
    expect(entry?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: `approval:${approvalId}`,
          kind: "approval",
          status: "approved",
          riskClass: "high",
          changeId: proposalId,
        }),
        expect.objectContaining({
          kind: "change-transition",
          status: "promoted",
          changeId: proposalId,
        }),
      ]),
    );
    expect(entry?.rollbacks.map((item) => item.ref)).toContain(
      `change:${proposalId}:commit:abc123`,
    );

    // The observer timeline exposes the same chain instead of id-only data.
    const timeline = await buildObserverTimeline(store, {
      workspaceId: "default",
    });
    const row = timeline.find((item) => item.event.eventId === "inf_chain");
    expect(row?.reaction?.jobId).toBe(iterationId);
    expect(row?.reaction?.chainComplete).toBe(true);
    expect(row?.reaction?.artifacts.map((item) => item.artifactId)).toContain(
      artifactId,
    );
    expect(
      row?.reaction?.decisions.some(
        (item) => item.ref === `approval:${approvalId}`,
      ),
    ).toBe(true);
    expect(row?.reaction?.rollbacks.length).toBeGreaterThan(0);
  }, 60_000);
});
