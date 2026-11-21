import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { reactionSignalId, readReactionSignals } from "../src/reaction-signal";
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
      model: "heuristic",
      profileVersion: 1,
      flags: [],
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
    reactionsPath: signalPath(root),
    killSwitchFn: (() => null) as unknown as FireTriggerDeps["killSwitchFn"],
    opsGateFn,
    startJobFn,
    onGate: (gate) => trail.push(gate),
    ...overrides,
  };
}

function signalPath(root: string): string {
  return path.join(root, "signals", "reactions.jsonl");
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

  it("writes one traceable signal at the reaction completion point", async () => {
    const { root, store } = await setup();
    const outcome = await reactToInformationEvent(
      eventRecord("inf_signal"),
      reactionDeps(store, root, [rule("rr_signal")]),
    );
    const candidate = outcome.candidates[0];
    expect(candidate?.decision).toBe("fired");
    expect(outcome.signalError).toBeUndefined();

    const file = await readReactionSignals(signalPath(root));
    expect(file.corrupt).toBe(0);
    expect(file.signals).toHaveLength(1);
    expect(file.signals[0]).toMatchObject({
      kind: "reaction.outcome",
      eventId: "inf_signal",
      ruleId: "rr_signal",
      ruleVersion: 1,
      triggerRunId: candidate?.triggerRunId,
      jobId: candidate?.jobId,
      outcome: "fired",
      gate: "write-back",
      dedupeKey: "inf_signal:rr_signal",
      at: "2026-11-20T12:00:00.000Z",
    });
    expect(file.signals[0]?.signalId).toBe(
      reactionSignalId({
        workspaceId: "default",
        eventId: "inf_signal",
        ruleId: "rr_signal",
        triggerRunId: candidate?.triggerRunId ?? null,
        outcome: "fired",
      }),
    );
  }, 60_000);

  it("does not append a second signal when the same reaction is replayed", async () => {
    const { root, store } = await setup();
    const rules = [rule("rr_signal_dedupe")];
    const first = await reactToInformationEvent(
      eventRecord("inf_signal_dedupe"),
      reactionDeps(store, root, rules),
    );
    const second = await reactToInformationEvent(
      eventRecord("inf_signal_dedupe"),
      reactionDeps(store, root, rules),
    );
    expect(first.candidates[0]?.decision).toBe("fired");
    expect(second.candidates[0]?.decision).toBe("existing");

    const file = await readReactionSignals(signalPath(root));
    expect(file.signals).toHaveLength(1);
    expect(file.signals[0]?.outcome).toBe("fired");
    expect(file.signals[0]?.triggerRunId).toBe(
      first.candidates[0]?.triggerRunId,
    );
  }, 60_000);

  it("records a failed launch and keeps a later successful retry visible", async () => {
    const { root, store } = await setup();
    const rules = [rule("rr_retry")];
    const failing = reactionDeps(store, root, rules, [], {
      startJobFn: (async () => {
        throw new Error("engine unavailable");
      }) as unknown as FireTriggerDeps["startJobFn"],
    });
    const first = await reactToInformationEvent(
      eventRecord("inf_retry"),
      failing,
    );
    expect(first.candidates[0]?.decision).toBe("failed");

    // Same trigger run id is resumed; a genuine success must be recorded.
    const retried = await reactToInformationEvent(
      eventRecord("inf_retry"),
      reactionDeps(store, root, rules),
    );
    expect(retried.candidates[0]?.decision).toBe("fired");
    expect(retried.candidates[0]?.triggerRunId).toBe(
      first.candidates[0]?.triggerRunId,
    );

    const signals = (await readReactionSignals(signalPath(root))).signals;
    expect(signals.map((signal) => signal.outcome)).toEqual([
      "failed",
      "fired",
    ]);
    expect(signals.every((signal) => signal.ruleId === "rr_retry")).toBe(true);
  }, 60_000);

  it("signals budget-exhausted and cap-reached decisions", async () => {
    const { root, store } = await setup();
    const budgeted = [
      rule("rr_signal_budget", { priority: 10, budget: { dailyRuns: 1 } }),
      rule("rr_signal_fallback", { priority: 0 }),
    ];
    await reactToInformationEvent(
      eventRecord("inf_signal_b1"),
      reactionDeps(store, root, budgeted),
    );
    const second = await reactToInformationEvent(
      eventRecord("inf_signal_b2"),
      reactionDeps(store, root, budgeted),
    );
    expect(second.candidates[0]?.decision).toBe("budget-exhausted");

    const capped = [
      rule("rr_signal_cap_1", { priority: 3 }),
      rule("rr_signal_cap_2", { priority: 1 }),
    ];
    const cappedOutcome = await reactToInformationEvent(
      eventRecord("inf_signal_cap"),
      reactionDeps(store, root, capped, [], { maxReactions: 1 }),
    );
    expect(cappedOutcome.candidates[1]?.decision).toBe("cap-reached");

    const signals = (await readReactionSignals(signalPath(root))).signals;
    const budgetSignal = signals.find(
      (signal) =>
        signal.eventId === "inf_signal_b2" &&
        signal.ruleId === "rr_signal_budget",
    );
    expect(budgetSignal).toMatchObject({
      outcome: "budget-exhausted",
      gate: "trigger-budget",
      triggerRunId: null,
      jobId: null,
    });
    const capSignal = signals.find(
      (signal) =>
        signal.eventId === "inf_signal_cap" &&
        signal.ruleId === "rr_signal_cap_2",
    );
    expect(capSignal).toMatchObject({
      outcome: "cap-reached",
      gate: null,
      jobId: null,
    });
  }, 60_000);

  it("reports a signal write failure without failing the dispatch", async () => {
    const { root, store } = await setup();
    const blocker = path.join(root, "blocker");
    await mkdir(root, { recursive: true });
    await writeFile(blocker, "not a directory", "utf8");

    const outcome = await reactToInformationEvent(
      eventRecord("inf_signal_error"),
      reactionDeps(store, root, [rule("rr_signal_error")], [], {
        reactionsPath: path.join(blocker, "reactions.jsonl"),
      }),
    );
    expect(outcome.fired).toBe(1);
    expect(typeof outcome.signalError).toBe("string");
    expect(outcome.signalError?.length).toBeGreaterThan(0);
  }, 60_000);

  it("keeps information in the default auto-approval scope", () => {
    expect(isAutoApproveOriginEligible("information")).toBe(true);
    expect(isAutoApproveOriginEligible("manual")).toBe(false);
  });
});
