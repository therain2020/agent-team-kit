import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ChangeProposal, newChangeProposal } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeApprovalIdFor,
  changeApprovalRunId,
} from "../src/change-approval-service";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-change-approval-"));
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
const LATER = "2026-11-25T00:00:00.000Z";

type Store = Awaited<ReturnType<typeof localStore>>;

/** Code and instruction proposals must travel the exact same pipeline. */
async function evaluatedProposal(
  store: Store,
  overrides: Partial<ChangeProposal> & {
    id: string;
    substrate: ChangeProposal["substrate"];
    revertRef: string;
  },
): Promise<ChangeProposal> {
  const proposal = newChangeProposal({
    id: overrides.id,
    workspaceId: "ws",
    substrate: overrides.substrate,
    producer: overrides.substrate === "code" ? "iterate" : "evolve",
    hypothesis: overrides.hypothesis ?? `proposal ${overrides.id}`,
    acceptance: ["checks pass"],
    risk: "high",
    evalPlan: {
      checks: ["typecheck", "test"],
      evalRefs: [],
      snapshotRef: null,
    },
    revertRef: overrides.revertRef,
    actor: "shadow:iterate",
    now: AT,
  });
  await store.changeProposals.create(proposal);
  await store.changeProposals.transition({
    proposalId: proposal.id,
    trigger: "evaluate",
    actor: "shadow:iterate",
    at: AT,
  });
  const evaluated = await store.changeProposals.transition({
    proposalId: proposal.id,
    trigger: "evaluation_passed",
    actor: "shadow:iterate",
    at: AT,
  });
  if (!evaluated.ok) {
    throw new Error("expected an evaluated proposal");
  }
  return evaluated.proposal;
}

function codeProposal(store: Store, id = "chg_code") {
  return evaluatedProposal(store, {
    id,
    substrate: "code",
    revertRef: "commit:abc123",
  });
}

function promptProposal(store: Store, id = "chg_prompt") {
  return evaluatedProposal(store, {
    id,
    substrate: "prompt",
    revertRef: "variant:baseline",
  });
}

describe("change approvals (sqlite)", () => {
  it("queues high-risk code and instruction changes with an identical shape", async () => {
    const store = await localStore();
    await codeProposal(store);
    await promptProposal(store);

    const code = await store.changeApprovals.request("chg_code", {
      requester: "shadow:iterate",
      now: AT,
    });
    const prompt = await store.changeApprovals.request("chg_prompt", {
      requester: "shadow:evolve",
      now: AT,
    });
    if (!code || !prompt) {
      throw new Error("expected both approvals to be queued");
    }

    const page = await store.approvals.list({ status: "queued" });
    expect(page.items).toHaveLength(2);
    // Same field shape on both substrates: nothing is forked for instructions.
    const [a, b] = page.items;
    expect(Object.keys(a ?? {}).sort()).toEqual(Object.keys(b ?? {}).sort());
    expect(page.items.map((item) => item.kind)).toEqual([
      "change_proposal",
      "change_proposal",
    ]);
    expect(page.items.map((item) => item.substrate).sort()).toEqual([
      "code",
      "prompt",
    ]);
    expect(page.items.map((item) => item.changeId).sort()).toEqual([
      "chg_code",
      "chg_prompt",
    ]);
    expect(code.approvalId).toBe(changeApprovalIdFor("chg_code"));
    expect(code.runId).toBe(changeApprovalRunId("chg_code"));
    // Change approvals survive the legacy `paused run` inbox filter.
    const inbox = await store.approvals.list({
      status: "queued",
      runStatus: "paused",
    });
    expect(inbox.items).toHaveLength(2);
  });

  it("does not queue low/medium risk proposals", async () => {
    const store = await localStore();
    const proposal = newChangeProposal({
      id: "chg_low",
      workspaceId: "ws",
      substrate: "code",
      producer: "iterate",
      hypothesis: "docs tweak",
      acceptance: ["ok"],
      risk: "low",
      revertRef: "commit:def",
      now: AT,
    });
    await store.changeProposals.create(proposal);
    await expect(
      store.changeApprovals.request("chg_low", { now: AT }),
    ).resolves.toBeNull();
  });

  it("replays enqueue and decision idempotently", async () => {
    const store = await localStore();
    await codeProposal(store);

    const first = await store.changeApprovals.request("chg_code", {
      requester: "shadow:iterate",
      now: AT,
    });
    const replay = await store.changeApprovals.request("chg_code", {
      requester: "shadow:iterate",
      now: AT,
    });
    expect(replay?.version).toBe(1);
    expect(replay?.expiresAt).toBe(first?.expiresAt);

    const approved = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "operator:web",
      reason: "ship it",
      idempotencyKey: "decide-chg-code",
      at: LATER,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) {
      throw new Error("expected approval");
    }
    expect(approved.duplicate).toBe(false);
    expect(approved.proposal.state).toBe("promoted");

    const again = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "operator:web",
      reason: "ship it",
      idempotencyKey: "decide-chg-code",
      at: LATER,
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.duplicate).toBe(true);
      expect(again.proposal.state).toBe("promoted");
    }

    const stored = await store.changeProposals.get("chg_code");
    expect(stored?.state).toBe("promoted");
    expect(stored?.approvalRef).toBe(changeApprovalIdFor("chg_code"));
  });

  it("rejects decisions on expired requests and stale versions", async () => {
    const store = await localStore();
    await codeProposal(store);
    await store.changeApprovals.request("chg_code", {
      requester: "shadow:iterate",
      now: AT,
      expiresAt: "2026-11-21T00:00:00.000Z",
      slaDueAt: "2026-11-21T00:00:00.000Z",
    });

    const expired = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "operator:web",
      reason: "late",
      at: LATER,
    });
    expect(expired).toMatchObject({ ok: false, code: "expired" });
    expect(
      await store.approvals.get(changeApprovalIdFor("chg_code")),
    ).toMatchObject({ status: "queued" });

    const stale = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "operator:web",
      reason: "wrong version",
      expectedVersion: 99,
      at: AT,
    });
    expect(stale).toMatchObject({ ok: false, code: "version_conflict" });

    const proposal = await store.changeProposals.get("chg_code");
    expect(proposal?.state).toBe("evaluated");
  });

  it("forbids the requester from approving their own change", async () => {
    const store = await localStore();
    await codeProposal(store);
    await store.changeApprovals.request("chg_code", {
      requester: "agent:author",
      now: AT,
    });

    const self = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "Agent:Author",
      reason: "self",
      at: AT,
    });
    expect(self).toMatchObject({ ok: false, code: "self_approval" });
    expect(
      await store.approvals.get(changeApprovalIdFor("chg_code")),
    ).toMatchObject({ status: "queued" });

    const other = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_code"),
      status: "approved",
      decisionBy: "operator:web",
      reason: "reviewed",
      at: AT,
    });
    expect(other.ok).toBe(true);
  });

  it("terminates the pipeline on rejection and audits the decision", async () => {
    const store = await localStore();
    await promptProposal(store);
    await store.changeApprovals.request("chg_prompt", {
      requester: "shadow:evolve",
      now: AT,
    });

    const rejected = await store.changeApprovals.decide({
      approvalId: changeApprovalIdFor("chg_prompt"),
      status: "rejected",
      decisionBy: "operator:web",
      reason: "not yet",
      at: LATER,
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) {
      throw new Error("expected rejection");
    }
    expect(rejected.record.status).toBe("rejected");
    expect(rejected.record.changeId).toBe("chg_prompt");
    expect(rejected.record.substrate).toBe("prompt");
    expect(rejected.proposal.state).toBe("blocked");

    const history = await store.changeProposals.listTransitions("chg_prompt");
    expect(history.at(-1)).toMatchObject({
      trigger: "block",
      actor: "operator:web",
      to: "blocked",
    });

    const audit = await store.sql<Array<{ kind: string; payload: string }>>`
      SELECT kind, payload FROM activity_events WHERE kind = 'approval.decided'
    `;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.payload ?? "{}")).toMatchObject({
      approvalId: changeApprovalIdFor("chg_prompt"),
      changeId: "chg_prompt",
      substrate: "prompt",
      status: "rejected",
      decisionBy: "operator:web",
    });
  });
});
