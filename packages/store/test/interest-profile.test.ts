import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_INTEREST_PROFILE, type SignalBlock } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { InterestProfileConflictError } from "../src/interest-profile-service";
import { initStore } from "../src/store";

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

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-interest-"));
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

const at = "2026-11-21T12:00:00.000Z";

function signals(overrides: Partial<SignalBlock> = {}): SignalBlock {
  return {
    relevance: 0.7,
    novelty: 0.6,
    urgency: 0.8,
    risk: 0.1,
    confidence: 0.6,
    reasons: ["relevance 0.70: topics 1/1 (ai)"],
    model: "heuristic",
    profileVersion: 1,
    flags: [],
    scoredAt: at,
    ...overrides,
  };
}

describe("InterestProfileService (sqlite)", () => {
  it("starts from the default profile before any edit", async () => {
    const store = await sqliteStore();
    expect(await store.interestProfiles.getCurrent()).toBeNull();
    const current = await store.interestProfiles.getCurrentOrDefault();
    expect(current.profileId).toBe(DEFAULT_INTEREST_PROFILE.profileId);
    expect(current.version).toBe(0);
  });

  it("writes a new immutable version plus an audit row per edit", async () => {
    const store = await sqliteStore();
    const first = await store.interestProfiles.saveProfile({
      topics: ["ai", "agents"],
      entities: ["OpenAI"],
      exclusions: ["crypto"],
      thresholds: { relevance: 0.6, novelty: 0.4, urgency: 0.5 },
      dailyBudgetCny: 2.5,
      updatedBy: "human",
      rationale: "Track AI agents and hold crypto out of the feed.",
      updatedAt: at,
    });
    expect(first.version).toBe(1);
    expect(first.profileId).toMatch(/^prf_/);
    expect(first.dailyBudgetCny).toBe(2.5);

    const second = await store.interestProfiles.saveProfile({
      topics: ["ai"],
      entities: ["OpenAI", "Anthropic"],
      exclusions: [],
      thresholds: { relevance: 0.7, novelty: 0.5, urgency: 0.6 },
      dailyBudgetCny: 5,
      updatedBy: "ai",
      actor: "composer",
      expectedVersion: 1,
      rationale: "Narrow to AI labs after the observer review.",
      updatedAt: "2026-11-21T13:00:00.000Z",
    });
    expect(second.version).toBe(2);
    expect(second.profileId).toBe(first.profileId);
    expect(second.thresholds.relevance).toBe(0.7);

    // Neither version is overwritten; the highest version is current.
    const versions = await store.interestProfiles.listVersions();
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect((await store.interestProfiles.getCurrent())?.version).toBe(2);

    const audit = await store.interestProfiles.listAudit();
    expect(audit).toHaveLength(2);
    const latest = audit[0];
    expect(latest?.action).toBe("update");
    expect(latest?.actor).toBe("composer");
    expect(latest?.before?.version).toBe(1);
    expect(latest?.after?.version).toBe(2);
    expect(latest?.rationale).toBe(
      "Narrow to AI labs after the observer review.",
    );
    expect(audit[1]?.action).toBe("create");
    expect(audit[1]?.before).toBeNull();
  });

  it("rejects stale expectedVersion and blank rationale", async () => {
    const store = await sqliteStore();
    await store.interestProfiles.saveProfile({
      topics: ["ai"],
      entities: [],
      exclusions: [],
      thresholds: { relevance: 0.5, novelty: 0.4, urgency: 0.5 },
      dailyBudgetCny: 0,
      updatedBy: "human",
      rationale: "Initial profile.",
    });

    await expect(
      store.interestProfiles.saveProfile({
        topics: ["ai"],
        entities: [],
        exclusions: [],
        thresholds: { relevance: 0.5, novelty: 0.4, urgency: 0.5 },
        dailyBudgetCny: 0,
        updatedBy: "human",
        expectedVersion: 0,
        rationale: "Stale write.",
      }),
    ).rejects.toBeInstanceOf(InterestProfileConflictError);

    await expect(
      store.interestProfiles.saveProfile({
        topics: ["ai"],
        entities: [],
        exclusions: [],
        thresholds: { relevance: 0.5, novelty: 0.4, urgency: 0.5 },
        dailyBudgetCny: 0,
        updatedBy: "human",
        rationale: "   ",
      }),
    ).rejects.toThrow(/rationale/);
  });

  it("records one signal per event and never rewrites history", async () => {
    const store = await sqliteStore();
    const first = await store.interestProfiles.recordSignal({
      eventId: "inf_1",
      signals: signals(),
    });
    expect(first).toBe(true);

    const second = await store.interestProfiles.recordSignal({
      eventId: "inf_1",
      signals: signals({ relevance: 0.01, reasons: ["rewritten"] }),
    });
    expect(second).toBe(false);

    const rows = await store.interestProfiles.listSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relevance).toBe(0.7);
    expect(rows[0]?.reasons).toEqual(["relevance 0.70: topics 1/1 (ai)"]);
    expect(rows[0]?.profileVersion).toBe(1);
    expect(rows[0]?.model).toBe("heuristic");
  });

  it("samples a deterministic audit subset and isolates workspaces", async () => {
    const store = await sqliteStore();
    for (const eventId of ["inf_a", "inf_b", "inf_c"]) {
      await store.interestProfiles.recordSignal({
        eventId,
        signals: signals({ profileVersion: 2, passes: true }),
      });
    }
    await store.interestProfiles.recordSignal({
      workspaceId: "other",
      eventId: "inf_other",
      signals: signals({ flags: ["injection-suspected"], risk: 0.9 }),
    });

    const sample = await store.interestProfiles.sampleSignals("default", 2);
    expect(sample.map((row) => row.eventId)).toEqual(["inf_a", "inf_b"]);
    expect(sample.every((row) => row.reasons.length > 0)).toBe(true);
    expect(sample.every((row) => row.passes)).toBe(true);

    const other = await store.interestProfiles.listSignals({
      workspaceId: "other",
    });
    expect(other).toHaveLength(1);
    expect(other[0]?.flags).toEqual(["injection-suspected"]);
    expect(await store.interestProfiles.listSignals()).toHaveLength(3);
  });

  it("keeps versions and signals across a schema re-run", async () => {
    const store = await sqliteStore();
    await store.interestProfiles.saveProfile({
      topics: ["ai"],
      entities: [],
      exclusions: [],
      thresholds: { relevance: 0.5, novelty: 0.4, urgency: 0.5 },
      dailyBudgetCny: 0,
      updatedBy: "human",
      rationale: "Initial profile.",
    });
    await store.interestProfiles.recordSignal({
      eventId: "inf_keep",
      signals: signals(),
    });

    const reopened = await initStore(store.config);
    closers.push(() => reopened.close());
    expect((await reopened.interestProfiles.getCurrent())?.version).toBe(1);
    expect(await reopened.interestProfiles.listSignals()).toHaveLength(1);
  });
});
