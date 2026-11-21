import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type InformationEvent, buildInformationEvent } from "@kit/core";
import {
  type InformationEventRecord,
  initStore,
  listOps,
  loadStoreConfig,
} from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  InformationAutoDispatcher,
  type InformationAutoDispatcherOptions,
  isReactionAutoDispatchEnabled,
  startInformationAutoDispatch,
} from "../src/auto-dispatch";
import type { FireTriggerDeps } from "../src/dispatch";
import { reactToInformationEvent } from "../src/reaction";
import { readReactionSignals } from "../src/reaction-signal";

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
  const root = await mkdtemp(path.join(tmpdir(), "kit-auto-dispatch-"));
  roots.push(root);
  await cp(
    path.join(process.cwd(), "packs", "tech-radar"),
    path.join(root, "packs", "tech-radar"),
    { recursive: true },
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

function eventFor(
  eventId: string,
  options: { fetchedAt?: string; title?: string } = {},
): InformationEvent {
  const fetchedAt = options.fetchedAt ?? "2026-11-20T10:00:00.000Z";
  return buildInformationEvent({
    workspaceId: "default",
    type: "information.item",
    sourceId: "arxiv",
    captureKey: `capture-${eventId}`,
    itemRef: `item-${eventId}`,
    contentRef: `ref-${eventId}`,
    fetchedAt,
    eventId,
    entities: ["OpenAI"],
    claims: [
      {
        claimId: `claim-${eventId}`,
        text: "OpenAI released a new agent SDK",
        entities: ["OpenAI"],
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
      relevance: 0.9,
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
}

async function persistEvent(
  store: Awaited<ReturnType<typeof initStore>>,
  eventId: string,
  options: { fetchedAt?: string; title?: string } = {},
): Promise<InformationEventRecord> {
  const appended = await store.information.appendEvent({
    event: eventFor(eventId, options),
    title: options.title ?? "New agent SDK",
    url: `https://example.com/${eventId}`,
    itemRef: `item-${eventId}`,
  });
  return appended.event;
}

async function saveRule(
  store: Awaited<ReturnType<typeof initStore>>,
  ruleId: string,
  overrides: { dailyRuns?: number } = {},
): Promise<void> {
  await store.reactionRules.saveRule(
    {
      workspaceId: "default",
      ruleId,
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
      ...(overrides.dailyRuns !== undefined
        ? { budget: { dailyRuns: overrides.dailyRuns } }
        : {}),
      approval: { autoApprove: true, maxRisk: "low" },
      priority: 0,
      source: "human",
      rationale: "test rule",
    },
    { actor: "test" },
  );
}

function signalPath(root: string): string {
  return path.join(root, "signals", "reactions.jsonl");
}

function dispatcherOptions(
  root: string,
  clock: () => Date,
  overrides: Partial<InformationAutoDispatcherOptions> = {},
): InformationAutoDispatcherOptions {
  const startJobFn = (async (_store: unknown, input: { kind: string }) => {
    jobSequence += 1;
    return {
      jobId: `job-auto-${jobSequence}`,
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
    repoRoot: root,
    workspaceId: "default",
    env: {},
    clock,
    // Look back far enough to see events created before the test clock.
    lookbackMs: 24 * 60 * 60_000,
    retry: { baseDelayMs: 1000, maxDelayMs: 4000, maxAttempts: 3 },
    reactionsPath: signalPath(root),
    killSwitchFn: (() => null) as unknown as FireTriggerDeps["killSwitchFn"],
    opsGateFn,
    startJobFn,
    ...overrides,
  };
}

describe("automatic information dispatch (98 G1)", () => {
  it("turns a persisted event into a job with no operator action", async () => {
    const { root, store } = await setup();
    await saveRule(store, "rr_auto");
    const event = await persistEvent(store, "inf_auto");
    const captured: Array<Record<string, unknown>> = [];
    const startJobFn = (async (
      _store: unknown,
      input: Record<string, unknown>,
    ) => {
      captured.push(input);
      jobSequence += 1;
      return {
        jobId: `job-${jobSequence}`,
        kind: "packRun",
        workflowId: `pack-job-${jobSequence}`,
        engine: "local",
        runMode: "DRY_RUN",
        pack: "tech-radar",
      };
    }) as unknown as FireTriggerDeps["startJobFn"];
    const clock = () => new Date("2026-11-20T12:00:00.000Z");
    const dispatcher = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock, { startJobFn }),
    );

    const summary = await dispatcher.runOnce();

    expect(summary.status).toBe("dispatched");
    expect(summary.events).toBe(1);
    expect(summary.fired).toBe(1);
    expect(summary.errors).toEqual([]);
    const origin = captured[0]?.origin as Record<string, unknown>;
    expect(origin.kind).toBe("information");
    expect(origin.reactionRuleId).toBe("rr_auto");

    const rows = await store.triggerRuns.list("default", {
      reactionRuleId: "rr_auto",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      triggerId: "information:rr_auto",
      kind: "information",
      jobKind: "packRun",
      status: "started",
      payloadRef: `information:${event.eventId}`,
      dedupeKey: `${event.eventId}:rr_auto`,
    });
  }, 60_000);

  it("replays without refiring a duplicate event (dedupe by eventId + ruleId)", async () => {
    const { root, store } = await setup();
    await saveRule(store, "rr_dedupe");
    const event = await persistEvent(store, "inf_auto_dedupe");
    const clock = () => new Date("2026-11-20T12:00:00.000Z");
    const first = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock),
    );
    const firstSummary = await first.runOnce();
    expect(firstSummary.fired).toBe(1);

    // A restarted dispatcher re-reads its lookback window; the TriggerRun slot
    // must turn the replay into USE_EXISTING instead of a second job.
    const second = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock),
    );
    const secondSummary = await second.runOnce();
    expect(secondSummary.events).toBe(1);
    expect(secondSummary.fired).toBe(0);
    expect(secondSummary.existing).toBe(1);

    const rows = await store.triggerRuns.list("default", {
      reactionRuleId: "rr_dedupe",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBeTruthy();

    // A manual replay (`kit reaction run` / POST /api/reactions/run) goes
    // through the same dedupe slot and must return the existing job.
    const manualOutcome = await reactToInformationEvent(event, {
      ...dispatcherOptions(root, clock),
      store,
      rules: await store.reactionRules.listCurrent("default"),
    });
    expect(manualOutcome.existing).toBe(1);
    expect(manualOutcome.fired).toBe(0);
  }, 60_000);

  it("retries failed launches with backoff and audits every attempt", async () => {
    const { root, store } = await setup();
    await saveRule(store, "rr_retry");
    await persistEvent(store, "inf_auto_retry");
    let nowMs = Date.parse("2026-11-20T12:00:00.000Z");
    const clock = () => new Date(nowMs);
    let shouldFail = true;
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (shouldFail) {
        throw new Error("engine unavailable");
      }
      jobSequence += 1;
      return {
        jobId: `job-retry-${jobSequence}`,
        kind: "packRun",
        workflowId: "pack-job",
        engine: "local",
        runMode: "DRY_RUN",
        pack: "tech-radar",
      };
    }) as unknown as FireTriggerDeps["startJobFn"];
    const dispatcher = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock, { startJobFn: flaky }),
    );

    const failed = await dispatcher.runOnce();
    expect(calls).toBe(1);
    expect(failed.failed).toBe(1);
    expect(failed.deferred).toBe(1);

    const retryOps = await listOps(store, {
      workspaceId: "default",
      entityKind: "reaction",
      limit: 100,
    });
    const scheduled = retryOps.find(
      (row) => row.op === "reaction.retry-scheduled",
    );
    expect(scheduled).toBeDefined();
    expect(scheduled?.payload).toMatchObject({
      eventId: "inf_auto_retry",
      ruleId: "rr_retry",
      attempt: 1,
      delayMs: 1000,
    });

    // Same clock: the next pass must not hammer the failing launch.
    const deferred = await dispatcher.runOnce();
    expect(deferred.retried).toBe(0);
    expect(calls).toBe(1);

    shouldFail = false;
    nowMs += 2_000;
    const retried = await dispatcher.runOnce();
    expect(retried.retried).toBe(1);
    expect(retried.fired).toBe(1);
    expect(calls).toBe(2);

    const rows = await store.triggerRuns.list("default", {
      reactionRuleId: "rr_retry",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("started");

    const signals = (await readReactionSignals(signalPath(root))).signals;
    expect(signals.map((signal) => signal.outcome)).toEqual([
      "failed",
      "fired",
    ]);
  }, 60_000);

  it("surfaces a budget rejection as an audited skipped reaction", async () => {
    const { root, store } = await setup();
    await saveRule(store, "rr_budget", { dailyRuns: 1 });
    await persistEvent(store, "inf_budget_a", {
      fetchedAt: "2026-11-20T10:00:01.000Z",
    });
    await persistEvent(store, "inf_budget_b", {
      fetchedAt: "2026-11-20T10:00:02.000Z",
    });
    const clock = () => new Date("2026-11-20T12:00:00.000Z");
    const dispatcher = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock),
    );

    const summary = await dispatcher.runOnce();

    expect(summary.events).toBe(2);
    expect(summary.fired).toBe(1);
    expect(summary.skipped).toBe(1);
    const rows = await store.triggerRuns.list("default", {
      reactionRuleId: "rr_budget",
    });
    expect(rows).toHaveLength(1);

    const ops = await listOps(store, {
      workspaceId: "default",
      entityKind: "reaction",
      limit: 100,
    });
    const budgetOp = ops.find((row) => row.op === "reaction.budget-exhausted");
    expect(budgetOp).toBeDefined();
    expect(budgetOp?.payload).toMatchObject({
      eventId: "inf_budget_b",
      ruleId: "rr_budget",
      decision: "budget-exhausted",
      gate: "trigger-budget",
    });

    const signals = (await readReactionSignals(signalPath(root))).signals;
    expect(
      signals.find((signal) => signal.eventId === "inf_budget_b"),
    ).toMatchObject({
      outcome: "budget-exhausted",
      ruleId: "rr_budget",
      jobId: null,
    });
  }, 60_000);
});

describe("auto-dispatch gates", () => {
  it("respects the kill switch through the shared fireTrigger path", async () => {
    const { root, store } = await setup();
    await saveRule(store, "rr_killed");
    await persistEvent(store, "inf_auto_killed");
    const clock = () => new Date("2026-11-20T12:00:00.000Z");
    let started = 0;
    const dispatcher = new InformationAutoDispatcher(
      store,
      dispatcherOptions(root, clock, {
        startJobFn: (async () => {
          started += 1;
          throw new Error("must not start while killed");
        }) as unknown as FireTriggerDeps["startJobFn"],
        killSwitchFn: (() => ({
          switchId: "ks_auto",
          scope: "workspace",
          target: "default",
          workspaceId: "default",
          state: "active",
          activatedBy: "operator:test",
          reason: "drill",
          activatedAt: "2026-11-20T11:00:00.000Z",
          releasedBy: null,
          releasedAt: null,
          releaseReason: null,
          version: 1,
          updatedAt: "2026-11-20T11:00:00.000Z",
        })) as unknown as FireTriggerDeps["killSwitchFn"],
      }),
    );

    const summary = await dispatcher.runOnce();

    expect(summary.fired).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(started).toBe(0);
    expect(summary.outcomes[0]?.candidates[0]?.gate).toBe("kill-switch");
    expect(
      await store.triggerRuns.list("default", { reactionRuleId: "rr_killed" }),
    ).toHaveLength(0);
  }, 60_000);
});

describe("auto-dispatch switch", () => {
  it("defaults to on and accepts explicit off values", () => {
    expect(isReactionAutoDispatchEnabled({})).toBe(true);
    expect(
      isReactionAutoDispatchEnabled({ KIT_REACTION_AUTO_DISPATCH: "1" }),
    ).toBe(true);
    for (const value of ["0", "false", "off", "no", "disabled"]) {
      expect(
        isReactionAutoDispatchEnabled({ KIT_REACTION_AUTO_DISPATCH: value }),
      ).toBe(false);
    }
  });

  it("returns no loop when the switch is off", async () => {
    const { root, store } = await setup();
    const loop = startInformationAutoDispatch(store, {
      ...dispatcherOptions(root, () => new Date()),
      env: { KIT_REACTION_AUTO_DISPATCH: "0" },
      runImmediately: false,
    });
    expect(loop).toBeNull();
  }, 60_000);
});
