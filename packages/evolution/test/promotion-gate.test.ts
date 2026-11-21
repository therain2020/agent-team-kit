import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promoteVariant, validateVariantNonLive } from "../src/evolve";
import {
  type PromotionApproval,
  PromotionGateError,
  evaluatePromotionGate,
} from "../src/promotion";

/**
 * Promotion gate matrix (70 §3.1/§3.3 invariants 5 and 7/§3.6, 50 §3.5).
 * Every fixture is a temp copy of the tech-radar pack; the real repository is
 * never written.
 */

const roots: string[] = [];
const PACK = path.join(process.cwd(), "packs", "tech-radar");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(prefix = "kit-promotion-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeArchitectureVariant(
  root: string,
  workspaceId = "ws-a",
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

async function makeTarget(root: string): Promise<string> {
  const dir = path.join(root, "packs", "target");
  await mkdir(path.dirname(dir), { recursive: true });
  await cp(PACK, dir, { recursive: true });
  return dir;
}

function approval(
  role: PromotionApproval["role"],
  status: PromotionApproval["status"] = "approved",
): PromotionApproval {
  return {
    approvalId: `apr_${role}`,
    role,
    status,
    workspaceId: "ws-a",
  };
}

const THREE_PARTY = [
  approval("operator"),
  approval("security"),
  approval("architecture"),
];

describe("evaluatePromotionGate", () => {
  it("fails an architecture promotion when any of the three approvals is missing", () => {
    const partial = evaluatePromotionGate({
      kind: "architecture",
      variantId: "var_arch",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: [approval("operator"), approval("security")],
      validation: { mode: "DRY_RUN", realSideEffects: 0 },
    });
    expect(partial.allowed).toBe(false);
    expect(partial.missingRoles).toEqual(["architecture"]);
    expect(partial.reasons.join("\n")).toMatch(/missing architecture/);

    const full = evaluatePromotionGate({
      kind: "architecture",
      variantId: "var_arch",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: THREE_PARTY,
      validation: { mode: "DRY_RUN", realSideEffects: 0 },
    });
    expect(full.allowed).toBe(true);
    expect(full.approvedRoles.sort()).toEqual([
      "architecture",
      "operator",
      "security",
    ]);
  });

  it("treats a rejected approval as blocking", () => {
    const decision = evaluatePromotionGate({
      kind: "architecture",
      variantId: "var_arch",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: [approval("operator"), approval("security", "rejected")],
      validation: { mode: "DRY_RUN", realSideEffects: 0 },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejectedRoles).toEqual(["security"]);
  });

  it("denies cross-workspace reuse unless an exemption matches exactly", () => {
    const cross = evaluatePromotionGate({
      kind: "context",
      variantId: "var_x",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-b",
    });
    expect(cross.allowed).toBe(false);
    expect(cross.crossWorkspace).toBe(true);
    expect(cross.reasons.join("\n")).toMatch(/explicit exemption/);

    const exemption = {
      exemptionId: "exm_1",
      variantId: "var_x",
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      reason: "shared baseline reviewed by security",
      approvedBy: "security:lead",
      approvedAt: "2026-11-21T00:00:00.000Z",
    };
    const allowed = evaluatePromotionGate({
      kind: "context",
      variantId: "var_x",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-b",
      exemption,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.exempted).toBe(true);
    expect(allowed.exemptionId).toBe("exm_1");

    const mismatched = evaluatePromotionGate({
      kind: "context",
      variantId: "var_x",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-c",
      exemption,
    });
    expect(mismatched.allowed).toBe(false);
  });

  it("requires a non-LIVE validation with zero real side effects for architecture", () => {
    const base = {
      kind: "architecture" as const,
      variantId: "var_arch",
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: THREE_PARTY,
    };
    expect(evaluatePromotionGate(base).allowed).toBe(false);
    expect(
      evaluatePromotionGate({
        ...base,
        validation: { mode: "LIVE", realSideEffects: 0 },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePromotionGate({
        ...base,
        validation: { mode: "SHADOW", realSideEffects: 2 },
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePromotionGate({
        ...base,
        validation: { mode: "SHADOW", realSideEffects: 0 },
      }).allowed,
    ).toBe(true);
  });
});

describe("promoteVariant gate", () => {
  it("refuses an architecture promotion with two approvals and leaves the target untouched", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    const target = await makeTarget(root);
    const before = await readFile(path.join(target, "team.yaml"), "utf8");

    let error: unknown;
    try {
      await promoteVariant(variant.dir, target, true, undefined, {
        variantWorkspaceId: "ws-a",
        targetWorkspaceId: "ws-a",
        approvals: [approval("operator"), approval("security")],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PromotionGateError);
    expect((error as PromotionGateError).code).toBe("missing_approval");
    expect(await readFile(path.join(target, "team.yaml"), "utf8")).toBe(before);
  });

  it("applies once operator, security and architecture all approve", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    const target = await makeTarget(root);

    const result = await promoteVariant(variant.dir, target, true, undefined, {
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: THREE_PARTY,
    });

    expect(result.apply).toBe(true);
    expect(result.kind).toBe("architecture");
    expect(result.gate?.allowed).toBe(true);
    expect(await readFile(path.join(target, "team.yaml"), "utf8")).toMatch(
      /architecture variant/,
    );
  });

  it("denies cross-workspace promotion by default and honours a recorded exemption", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    const target = await makeTarget(root);

    let error: unknown;
    try {
      await promoteVariant(variant.dir, target, true, undefined, {
        variantWorkspaceId: "ws-a",
        targetWorkspaceId: "ws-b",
        approvals: THREE_PARTY.map((item) => ({
          ...item,
          workspaceId: "ws-b",
        })),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PromotionGateError);
    expect((error as PromotionGateError).code).toBe("cross_workspace");

    const result = await promoteVariant(variant.dir, target, true, undefined, {
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-b",
      approvals: THREE_PARTY.map((item) => ({
        ...item,
        workspaceId: "ws-b",
      })),
      exemption: {
        exemptionId: "exm_cross",
        variantId: variant.id,
        fromWorkspaceId: "ws-a",
        toWorkspaceId: "ws-b",
        reason: "shared architecture baseline",
        approvedBy: "security:lead",
        approvedAt: "2026-11-21T00:00:00.000Z",
      },
    });
    expect(result.gate?.exempted).toBe(true);
    expect(result.gate?.exemptionId).toBe("exm_cross");
  });

  it("reports the gate on a dry run without writing", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    const target = await makeTarget(root);
    const before = await readFile(path.join(target, "team.yaml"), "utf8");

    const result = await promoteVariant(variant.dir, target, false, undefined, {
      variantWorkspaceId: "ws-a",
      targetWorkspaceId: "ws-a",
      approvals: THREE_PARTY,
    });
    expect(result.apply).toBe(false);
    expect(result.gate?.allowed).toBe(true);
    expect(await readFile(path.join(target, "team.yaml"), "utf8")).toBe(before);
  });
});

describe("validateVariantNonLive", () => {
  it("validates in DRY_RUN with zero real side effects", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    const target = await makeTarget(root);
    const before = await readFile(path.join(target, "team.yaml"), "utf8");

    const validation = await validateVariantNonLive(variant.dir);
    expect(validation.mode).toBe("DRY_RUN");
    expect(validation.realSideEffects).toBe(0);
    expect(validation.checkedFiles).toEqual(["team.yaml"]);
    expect(validation.validationRef).toContain("var_arch");
    expect(await readFile(path.join(target, "team.yaml"), "utf8")).toBe(before);
    expect(existsSync(path.join(target, "variant.json"))).toBe(false);
  });

  it("rejects LIVE validation", async () => {
    const root = await tempRoot();
    const variant = await makeArchitectureVariant(root);
    await expect(
      validateVariantNonLive(variant.dir, { mode: "LIVE" }),
    ).rejects.toThrow(/non-LIVE|outside LIVE/);
  });
});
