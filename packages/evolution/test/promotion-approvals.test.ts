import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StoreEvolutionRepository, promoteVariant } from "@kit/evolution";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePromotionGate } from "../src/promotion";
import {
  loadPromotionApprovals,
  requestPromotionApprovals,
} from "../src/promotion-approvals";

/**
 * Three-party promotion approvals ride on the unified `approvals` table
 * (#88 inbox) and the promotion decision lands in `evolution_decisions`
 * (70 §3.1/§3.6). This test walks the whole loop against SQLite.
 */

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const PACK = path.join(process.cwd(), "packs", "tech-radar");

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "kit-promotion-store-"));
  dirs.push(dir);
  const variantsRoot = path.join(dir, "variants");
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  const repo = new StoreEvolutionRepository(store, {
    variantsRoot,
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
  });
  return { dir, store, repo };
}

async function makeVariant(
  root: string,
  workspaceId: string,
): Promise<{ dir: string; id: string }> {
  const dir = path.join(root, "variants", "arch");
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(PACK, dir, { recursive: true });
  await writeFile(
    path.join(dir, "team.yaml"),
    `${await readFile(path.join(PACK, "team.yaml"), "utf8")}\n# architecture variant\n`,
    "utf8",
  );
  const id = "var_arch";
  await writeFile(
    path.join(dir, "variant.json"),
    JSON.stringify(
      {
        id,
        name: "arch",
        parent: null,
        agentId: "writer",
        model: "stub",
        createdAt: "2026-11-21T00:00:00.000Z",
        baselineHashes: {},
        changedFiles: ["team.yaml"],
        kind: "architecture",
        workspaceId,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, id };
}

describe("promotion approvals", () => {
  it("collects three-party approvals, promotes with an audited exemption and records the decision", async () => {
    const { dir, store, repo } = await setup();
    const variant = await makeVariant(dir, "ws-legacy");
    const target = path.join(dir, "packs", "target");
    await mkdir(path.dirname(target), { recursive: true });
    await cp(PACK, target, { recursive: true });

    const requested = await requestPromotionApprovals(store.approvals, {
      workspaceId: repo.workspaceId,
      variantId: variant.id,
      variantKind: "architecture",
      targetDir: target,
      requester: "operator:test",
    });
    expect(requested.map((row) => row.requiredRole).sort()).toEqual([
      "architecture",
      "operator",
      "security",
    ]);
    expect(requested.every((row) => row.status === "queued")).toBe(true);
    expect(requested[0]?.subjectRef).toContain("promotion:var_arch:");

    // Decide two of the three roles first: promotion stays blocked.
    for (const role of ["operator", "security"]) {
      const row = requested.find((item) => item.requiredRole === role);
      const decided = await store.approvals.decide({
        approvalId: row?.approvalId ?? "",
        expectedVersion: row?.version ?? 0,
        status: "approved",
        decisionBy: `${role}:lead`,
        decisionReason: `${role} signed off`,
      });
      expect(decided.ok).toBe(true);
    }
    const partial = await loadPromotionApprovals(store.approvals, {
      workspaceId: repo.workspaceId,
      variantId: variant.id,
      targetDir: target,
    });
    expect(partial).toHaveLength(3);
    const blocked = evaluatePromotionGate({
      kind: "architecture",
      variantId: variant.id,
      variantWorkspaceId: "ws-legacy",
      targetWorkspaceId: repo.workspaceId,
      approvals: partial,
      validation: { mode: "DRY_RUN", realSideEffects: 0 },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.missingRoles).toEqual(["architecture"]);

    const last = requested.find((item) => item.requiredRole === "architecture");
    const decided = await store.approvals.decide({
      approvalId: last?.approvalId ?? "",
      expectedVersion: last?.version ?? 0,
      status: "approved",
      decisionBy: "architecture:lead",
      decisionReason: "structure reviewed",
    });
    expect(decided.ok).toBe(true);

    const approvals = await loadPromotionApprovals(store.approvals, {
      workspaceId: repo.workspaceId,
      variantId: variant.id,
      targetDir: target,
    });
    expect(approvals.every((item) => item.status === "approved")).toBe(true);

    const exemption = {
      exemptionId: "exm_audit",
      variantId: variant.id,
      fromWorkspaceId: "ws-legacy",
      toWorkspaceId: repo.workspaceId,
      reason: "legacy variant reviewed by security",
      approvedBy: "security:lead",
      approvedAt: "2026-11-21T00:00:00.000Z",
    };
    const result = await promoteVariant(variant.dir, target, true, repo, {
      variantWorkspaceId: "ws-legacy",
      targetWorkspaceId: repo.workspaceId,
      approvals,
      exemption,
      actor: "operator:test",
    });
    expect(result.apply).toBe(true);
    expect(result.gate?.exempted).toBe(true);

    const decisions = await repo.listDecisions(10);
    const gateDecision = decisions.find(
      (decision) => decision.kind === "promotion_gate",
    );
    expect(gateDecision).toBeDefined();
    expect(gateDecision?.exemptionRef).toBe("exm_audit");
    expect(gateDecision?.variantKind).toBe("architecture");
    expect(gateDecision?.actor).toBe("operator:test");
  }, 30_000);
});
