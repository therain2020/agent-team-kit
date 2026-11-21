import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReactionRuleSaveInput } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import {
  ReactionRuleApprovalError,
  ReactionRuleConflictError,
} from "../src/reaction-rule-service";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-reaction-rule-"));
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

const AT = "2026-11-21T12:00:00.000Z";

function input(overrides: Record<string, unknown> = {}): ReactionRuleSaveInput {
  return {
    name: "React to agent SDK news",
    enabled: true,
    match: {
      eventType: "information.*",
      topics: ["agent"],
      entities: ["OpenAI"],
      minSignals: { relevance: 0.5 },
    },
    target: {
      packDir: "tech-radar",
      jobKind: "packRun" as const,
      workflow: "daily-radar",
    },
    runMode: "DRY_RUN" as const,
    budget: { dailyRuns: 3 },
    priority: 2,
    source: "human" as const,
    rationale: "Agent SDK news should produce one radar run.",
    ...overrides,
  } as unknown as ReactionRuleSaveInput;
}

describe("ReactionRuleService (sqlite)", () => {
  it("starts empty and writes immutable versions with an audit row", async () => {
    const store = await sqliteStore();
    expect(await store.reactionRules.listCurrent()).toEqual([]);
    expect(
      await store.reactionRules.getCurrent("default", "missing"),
    ).toBeNull();

    const first = await store.reactionRules.saveRule(input(), {
      actor: "observer",
      updatedAt: AT,
    });
    expect(first.version).toBe(1);
    expect(first.ruleId).toMatch(/^rr_/);
    expect(first.source).toBe("human");
    expect(first.budget?.dailyRuns).toBe(3);

    const second = await store.reactionRules.saveRule(
      input({
        ruleId: first.ruleId,
        name: "React to agent SDK news v2",
        expectedVersion: 1,
        priority: 5,
      }),
      { actor: "observer", updatedAt: "2026-11-21T13:00:00.000Z" },
    );
    expect(second.version).toBe(2);
    expect(second.ruleId).toBe(first.ruleId);
    expect(second.priority).toBe(5);

    const versions = await store.reactionRules.listVersions(
      "default",
      first.ruleId,
    );
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(
      (await store.reactionRules.getCurrent("default", first.ruleId))?.version,
    ).toBe(2);

    const audit = await store.reactionRules.listAudit();
    expect(audit.map((row) => row.action)).toEqual(["update", "create"]);
    expect(audit[1]?.before).toBeNull();
    expect(audit[1]?.after.version).toBe(1);
  });

  it("orders current rules by priority desc then ruleId", async () => {
    const store = await sqliteStore();
    await store.reactionRules.saveRule(input({ ruleId: "rr_b", priority: 1 }));
    await store.reactionRules.saveRule(input({ ruleId: "rr_a", priority: 1 }));
    await store.reactionRules.saveRule(
      input({ ruleId: "rr_top", priority: 9 }),
    );

    const rules = await store.reactionRules.listCurrent();
    expect(rules.map((rule) => rule.ruleId)).toEqual([
      "rr_top",
      "rr_a",
      "rr_b",
    ]);
    expect(
      (await store.reactionRules.listCurrent("default", { enabledOnly: true }))
        .length,
    ).toBe(3);
  });

  it("rejects stale versions and AI-authored saves", async () => {
    const store = await sqliteStore();
    const first = await store.reactionRules.saveRule(input());
    await expect(
      store.reactionRules.saveRule(
        input({ ruleId: first.ruleId, expectedVersion: 9 }),
      ),
    ).rejects.toBeInstanceOf(ReactionRuleConflictError);

    await expect(
      store.reactionRules.saveRule(input({ source: "ai" })),
    ).rejects.toBeInstanceOf(ReactionRuleApprovalError);
  });

  it("appends a version when an observer toggles a rule", async () => {
    const store = await sqliteStore();
    const first = await store.reactionRules.saveRule(input());
    const disabled = await store.reactionRules.setEnabled({
      ruleId: first.ruleId,
      enabled: false,
      rationale: "The radar is too noisy this week.",
      actor: "observer",
      updatedAt: "2026-11-21T14:00:00.000Z",
    });
    expect(disabled.version).toBe(2);
    expect(disabled.enabled).toBe(false);
    expect(
      (await store.reactionRules.listCurrent("default", { enabledOnly: true }))
        .length,
    ).toBe(0);
  });
});
