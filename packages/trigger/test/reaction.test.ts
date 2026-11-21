import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type InformationEvent,
  type ReactionRule,
  buildInformationEvent,
  isAutoApproveOriginEligible,
  reactionRuleSchema,
} from "@kit/core";
import {
  type InformationEventRecord,
  initStore,
  loadStoreConfig,
} from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import type { FireTriggerDeps } from "../src/dispatch";
import {
  type ReactionDeps,
  evaluateReactionRules,
  matchReactionRule,
  reactToInformationEvent,
  reactionEventView,
  traceReactions,
} from "../src/reaction";
import { DISPATCH_GATES, type DispatchGate } from "../src/types";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
let jobSequence = 0;

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-reaction-"));
  roots.push(root);
  await cp(
    path.join(process.cwd(), "packs", "tech-radar"),
    path.join(root, "packs", "tech-radar"),
    {
      recursive: true,
    },
  );
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

function eventRecord(
  eventId: string,
  overrides: {
    title?: string;
    entities?: string[];
    relevance?: number;
    eventType?: string;
  } = {},
): InformationEventRecord {
  const fetchedAt = "2026-11-20T10:00:00.000Z";
  const event = buildInformationEvent({
    workspaceId: "default",
    type: overrides.eventType ?? "information.item",
    sourceId: "arxiv",
    captureKey: `capture-${eventId}`,
    itemRef: `item-${eventId}`,
    contentRef: `ref-${eventId}`,
    fetchedAt,
    eventId,
    entities: overrides.entities ?? ["OpenAI"],
    claims: [
      {
        claimId: `claim-${eventId}`,
        text: "OpenAI released a new agent SDK",
        entities: overrides.entities ?? ["OpenAI"],
        provenance: [
          {
            captureKey: `capture-${eventId}`,
            sourceId: "arxiv",
            contentRef: `ref-${eventId}`,
            fetchedAt,
          },
        ],
      },
    ],
    signals: {
      relevance: overrides.relevance ?? 0.9,
      novelty: 0.8,
      urgency: 0.7,
      risk: 0.1,
      confidence: 0.8,
      reasons: ["test signal"],
    },
  });
  return recordFrom(
    event,
    overrides.title ?? "New agent SDK",
    `https://example.com/${eventId}`,
  );
}

function recordFrom(
  event: InformationEvent,
  title: string,
  url: string,
): InformationEventRecord {
  return {
    eventId: event.eventId,
    eventType: event.type,
    workspaceId: event.workspaceId,
    sourceId: event.sourceId,
    sourceKind: event.sourceKind,
    captureKey: event.captureKey,
    dedupeKey: event.dedupeKey,
    itemRef: event.itemRefs[0] ?? event.eventId,
    url,
    title,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sensitivity: event.sensitivity,
    payload: event,
    createdAt: event.receivedAt,
  };
}

function rule(
  ruleId: string,
  overrides: Partial<ReactionRule> = {},
): ReactionRule {
  return reactionRuleSchema.parse({
    ruleId,
    workspaceId: "default",
    name: ruleId,
    enabled: true,
    match: {
      eventType: "information.*",
      topics: ["agent"],
      entities: ["OpenAI"],
      minSignals: { relevance: 0.5 },
    },
    target: {
      packDir: "tech-radar",
      jobKind: "packRun",
      workflow: "daily-radar",
    },
    missionTemplate: "React to {title}",
    runMode: "DRY_RUN",
    approval: { autoApprove: true, maxRisk: "low" },
    priority: 0,
    version: 1,
    source: "human",
    rationale: "test rule",
    ...overrides,
  });
}

function reactionDeps(
  store: Awaited<ReturnType<typeof initStore>>,
  root: string,
  rules: ReactionRule[],
  trail: DispatchGate[] = [],
  overrides: Partial<ReactionDeps> = {},
): ReactionDeps {
  const startJobFn = (async (_store: unknown, input: { kind: string }) => {
    jobSequence += 1;
    return {
      jobId: `job-${jobSequence}`,
      kind: input.kind,
      workflowId: `pack-job-${jobSequence}`,
      engine: "local",
      runMode: "DRY_RUN",
      pack: "tech-radar",
    };
  }) as unknown as FireTriggerDeps["startJobFn"];
  const opsGateFn = (async () => ({
    readOnly: false,
    nightMode: false,
    nightException: false,
    reason: null,
    timezone: "UTC",
    action: null,
  })) as unknown as FireTriggerDeps["opsGateFn"];
  return {
    store,
    repoRoot: root,
    now: new Date("2026-11-20T12:00:00.000Z"),
    env: {},
    rules,
    killSwitchFn: (() => null) as unknown as FireTriggerDeps["killSwitchFn"],
    opsGateFn,
    startJobFn,
    onGate: (gate) => trail.push(gate),
    ...overrides,
  };
}

describe("reaction rule matching", () => {
  it("matches deterministically and explains every dimension", () => {
    const event = eventRecord("inf_match");
    const view = reactionEventView(event);
    const matched = matchReactionRule(rule("rr_match"), view);
    expect(matched.matched).toBe(true);
    expect(matched.reasons.join(" ")).toContain("topics matched: agent");
    expect(matched.reasons.join(" ")).toContain("entities matched: OpenAI");

    const miss = matchReactionRule(
      rule("rr_miss", {
        match: {
          eventType: "information.alert",
          topics: ["quantum"],
          entities: [],
          minSignals: {},
        },
      }),
      view,
    );
    expect(miss.matched).toBe(false);
    expect(miss.reasons.join(" ")).toContain("does not match");
    expect(miss.reasons.join(" ")).toContain("not found");
  });

  it("orders candidates by priority then ruleId, independent of input order", () => {
    const event = eventRecord("inf_order");
    const rules = [
      rule("rr_b", { priority: 5 }),
      rule("rr_a", { priority: 5 }),
      rule("rr_high", { priority: 9 }),
    ];
    const candidates = evaluateReactionRules(rules, event);
    expect(candidates.map((item) => item.ruleId)).toEqual([
      "rr_high",
      "rr_a",
      "rr_b",
    ]);
    expect(candidates.every((item) => item.matched)).toBe(true);
  });

  it("marks below-threshold signals as not matched", () => {
    const event = eventRecord("inf_low", { relevance: 0.2 });
    const candidate = evaluateReactionRules([rule("rr_threshold")], event)[0];
    expect(candidate?.matched).toBe(false);
    expect(candidate?.decision).toBe("not-matched");
    expect(candidate?.reasons.join(" ")).toContain("scored 0.2");
  });
});

describe("information-driven dispatch", () => {
  it("walks the full D-66 gate order through fireTrigger", async () => {
    const { root, store } = await setup();
    const trail: DispatchGate[] = [];
    const outcome = await reactToInformationEvent(
      eventRecord("inf_gate"),
      reactionDeps(store, root, [rule("rr_gate")], trail),
    );

    expect(outcome.fired).toBe(1);
    expect(outcome.candidates[0]?.decision).toBe("fired");
    expect(trail).toEqual([...DISPATCH_GATES]);
  }, 60_000);

  it("dedupes by eventId + ruleId and reuses the job on replay", async () => {
    const { root, store } = await setup();
    const rules = [rule("rr_dedupe")];
    const first = await reactToInformationEvent(
      eventRecord("inf_dedupe"),
      reactionDeps(store, root, rules),
    );
    const second = await reactToInformationEvent(
      eventRecord("inf_dedupe"),
      reactionDeps(store, root, rules),
    );

    expect(first.candidates[0]?.decision).toBe("fired");
    expect(second.candidates[0]?.decision).toBe("existing");
    expect(second.candidates[0]?.jobId).toBe(first.candidates[0]?.jobId);
    const rows = await store.triggerRuns.list("default", {
      reactionRuleId: "rr_dedupe",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe("inf_dedupe:rr_dedupe");
  }, 60_000);

  it("stops a rule at its UTC-day budget while lower priority rules still fire", async () => {
    const { root, store } = await setup();
    const rules = [
      rule("rr_budgeted", {
        priority: 10,
        budget: { dailyRuns: 1 },
      }),
      rule("rr_fallback", { priority: 0 }),
    ];
    const first = await reactToInformationEvent(
      eventRecord("inf_budget_1"),
      reactionDeps(store, root, rules),
    );
    expect(first.candidates.map((item) => item.decision)).toEqual([
      "fired",
      "fired",
    ]);

    const second = await reactToInformationEvent(
      eventRecord("inf_budget_2"),
      reactionDeps(store, root, rules),
    );
    const byRule = new Map(
      second.candidates.map((item) => [item.ruleId, item.decision]),
    );
    expect(byRule.get("rr_budgeted")).toBe("budget-exhausted");
    expect(byRule.get("rr_fallback")).toBe("fired");
  }, 60_000);

  it("caps reactions per event (storm protection)", async () => {
    const { root, store } = await setup();
    const rules = [
      rule("rr_cap_1", { priority: 3 }),
      rule("rr_cap_2", { priority: 2 }),
      rule("rr_cap_3", { priority: 1 }),
    ];
    const outcome = await reactToInformationEvent(
      eventRecord("inf_cap"),
      reactionDeps(store, root, rules, [], { maxReactions: 2 }),
    );
    expect(outcome.candidates.map((item) => item.decision)).toEqual([
      "fired",
      "fired",
      "cap-reached",
    ]);
    expect(outcome.fired).toBe(2);
  }, 60_000);

  it("records event → rule → job and persists reactionRuleId on origin and TriggerRun", async () => {
    const { root, store } = await setup();
    const captured: Array<Record<string, unknown>> = [];
    const startJobFn = (async (
      _store: unknown,
      input: Record<string, unknown>,
    ) => {
      captured.push(input);
      jobSequence += 1;
      return {
        jobId: `job-trace-${jobSequence}`,
        kind: "packRun",
        workflowId: "pack-job",
        engine: "local",
        runMode: "DRY_RUN",
        pack: "tech-radar",
      };
    }) as unknown as FireTriggerDeps["startJobFn"];

    const outcome = await reactToInformationEvent(
      eventRecord("inf_trace"),
      reactionDeps(store, root, [rule("rr_trace")], [], { startJobFn }),
    );
    const candidate = outcome.candidates[0];
    expect(candidate?.decision).toBe("fired");

    const origin = captured[0]?.origin as Record<string, unknown>;
    expect(origin.kind).toBe("information");
    expect(origin.reactionRuleId).toBe("rr_trace");
    expect(origin.triggerRunId).toBe(candidate?.triggerRunId);

    const trace = await traceReactions({ store }, "default", "inf_trace");
    expect(trace).toEqual([
      expect.objectContaining({
        ruleId: "rr_trace",
        jobId: candidate?.jobId,
        triggerRunId: candidate?.triggerRunId,
        status: "started",
      }),
    ]);
  }, 60_000);

  it("keeps information in the default auto-approval scope", () => {
    expect(isAutoApproveOriginEligible("information")).toBe(true);
    expect(isAutoApproveOriginEligible("manual")).toBe(false);
  });
});
