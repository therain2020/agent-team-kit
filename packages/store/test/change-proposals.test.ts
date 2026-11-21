import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newChangeProposal } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { initStore } from "../src/store";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-change-"));
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

const AT = "2026-11-20T00:00:00.000Z";

function proposal(id = "chg_test_1") {
  return newChangeProposal({
    id,
    workspaceId: "ws",
    substrate: "code",
    producer: "iterate",
    signalRefs: ["iterations:it_1/task-a"],
    hypothesis: "make verification deterministic",
    acceptance: ["typecheck, test and lint pass"],
    risk: "medium",
    evalPlan: {
      checks: ["typecheck", "test"],
      evalRefs: ["artifact:verification"],
      snapshotRef: null,
    },
    revertRef: "commit:abc123",
    contentRef: null,
    sourceRef: { kind: "iteration", id: "it_1", taskId: "task-a" },
    actor: "shadow:iterate",
    now: AT,
  });
}

describe("change proposal store (sqlite)", () => {
  it("round-trips a proposal and its submission audit row", async () => {
    const store = await localStore();
    const created = proposal();
    await store.changeProposals.create(created);

    const fetched = await store.changeProposals.get(created.id);
    expect(fetched?.state).toBe("proposed");
    expect(fetched?.hypothesis).toBe("make verification deterministic");
    expect(fetched?.evalPlan.checks).toEqual(["typecheck", "test"]);
    expect(fetched?.sourceRef).toEqual({
      kind: "iteration",
      id: "it_1",
      taskId: "task-a",
    });
    expect(fetched?.history).toHaveLength(1);
    expect(fetched?.history[0]?.trigger).toBe("submit");
    expect(fetched?.version).toBe(0);
  });

  it("persists transitions and appends immutable audit rows", async () => {
    const store = await localStore();
    const created = proposal();
    await store.changeProposals.create(created);

    const first = await store.changeProposals.transition({
      proposalId: created.id,
      trigger: "evaluate",
      actor: "shadow:iterate",
      reason: "verification ran",
      at: "2026-11-20T00:01:00.000Z",
      expectedVersion: created.version,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("transition failed");
    }
    expect(first.proposal.state).toBe("evaluating");
    expect(first.proposal.history).toHaveLength(2);
    expect(first.proposal.history.at(-1)?.to).toBe("evaluating");

    const second = await store.changeProposals.transition({
      proposalId: created.id,
      trigger: "evaluation_passed",
      actor: "shadow:iterate",
      reason: "checks passed",
      at: "2026-11-20T00:02:00.000Z",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error("transition failed");
    }
    expect(second.proposal.state).toBe("evaluated");

    const transitions = await store.changeProposals.listTransitions(created.id);
    expect(transitions.map((entry) => entry.to)).toEqual([
      "proposed",
      "evaluating",
      "evaluated",
    ]);
    expect(new Set(transitions.map((entry) => entry.auditId)).size).toBe(3);
  });

  it("rejects a stale compare-and-set and illegal transitions", async () => {
    const store = await localStore();
    const created = proposal("chg_test_2");
    await store.changeProposals.create(created);

    const stale = await store.changeProposals.transition({
      proposalId: created.id,
      trigger: "evaluate",
      actor: "shadow:iterate",
      reason: "racy read",
      expectedVersion: 99,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("version_conflict");
    }

    const illegal = await store.changeProposals.transition({
      proposalId: created.id,
      trigger: "promote",
      actor: "shadow:iterate",
      reason: "skip evaluation",
    });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.code).toBe("illegal_transition");
      expect(illegal.current?.state).toBe("proposed");
    }
  });

  it("stores payload content in blob storage and keeps only a reference", async () => {
    const store = await localStore();
    const created = proposal("chg_test_3");
    const content = new TextEncoder().encode('{"diff":"+hello"}');
    const stored = await store.changeProposals.create(created, { content });

    expect(stored.contentRef).toMatch(/^blb_/);
    expect(stored.hypothesis).not.toContain("+hello");
    const read = await store.changeProposals.readContent(stored.id);
    expect(read && new TextDecoder().decode(read)).toBe('{"diff":"+hello"}');
  });

  it("lists proposals by workspace, state and producer", async () => {
    const store = await localStore();
    await store.changeProposals.create(proposal("chg_list_1"));
    const prompt = newChangeProposal({
      id: "chg_list_2",
      workspaceId: "ws",
      substrate: "prompt",
      producer: "evolve",
      hypothesis: "sharpen the instruction contract",
      acceptance: ["candidate beats baseline"],
      risk: "low",
      revertRef: "variant:baseline",
      now: AT,
    });
    await store.changeProposals.create(prompt);

    const all = await store.changeProposals.list({ workspaceId: "ws" });
    expect(all).toHaveLength(2);
    const evolveOnly = await store.changeProposals.list({
      workspaceId: "ws",
      producer: "evolve",
    });
    expect(evolveOnly.map((item) => item.id)).toEqual(["chg_list_2"]);
    const proposed = await store.changeProposals.list({
      workspaceId: "ws",
      state: "proposed",
    });
    expect(proposed).toHaveLength(2);
  });
});
