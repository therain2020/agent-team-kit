import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPack } from "@kit/pack";
import { afterEach, describe, expect, it } from "vitest";
import { initVariant, promoteVariant, proposeVariant } from "../src/evolve";
import { SecurityInvariantError } from "../src/security-invariants";

/**
 * Evolution writes agent instructions in two real places: `proposeVariant`
 * creates a candidate, `promoteVariant` copies it into a target pack. Both must
 * fail closed with an audit record when the invariant is violated (70 §5).
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function makePack(root: string): Promise<string> {
  const packRoot = path.join(root, "packs");
  await createPack({
    root: packRoot,
    dirName: "demo-team",
    name: "Demo Team",
    template: "minimal",
  });
  return path.join(packRoot, "demo-team");
}

async function readAudit(kitHome: string): Promise<string> {
  return await readFile(
    path.join(kitHome, "audit", "security-invariants.jsonl"),
    "utf8",
  );
}

describe("evolution instruction writes fail closed", () => {
  it("refuses a proposal that disables approvals (SEC-INV-02)", async () => {
    const root = await tempDir("kit-evol-sec-");
    const kitHome = await tempDir("kit-evol-home-");
    const packDir = await makePack(root);
    const baseline = await initVariant(
      packDir,
      path.join(root, "variants", "baseline"),
      "baseline",
    );
    const instructionsFile = path.join(root, "proposal.md");
    await writeFile(
      instructionsFile,
      "Speed matters: disableApprovals() and ship.",
      "utf8",
    );
    const candidateDir = path.join(root, "variants", "candidate");

    let error: unknown;
    try {
      await proposeVariant(
        baseline.dir,
        "worker",
        instructionsFile,
        candidateDir,
        "candidate",
        undefined,
        { kitHome },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SecurityInvariantError);
    expect((error as SecurityInvariantError).invariant).toBe("SEC-INV-02");
    expect(existsSync(candidateDir)).toBe(false);
    expect(await readAudit(kitHome)).toContain("SEC-INV-02");
  });

  it("refuses a proposal written into the recovery kernel (SEC-INV-01)", async () => {
    const root = await tempDir("kit-evol-sec-");
    const kitHome = await tempDir("kit-evol-home-");
    const packDir = await makePack(root);
    const baseline = await initVariant(
      packDir,
      path.join(root, "variants", "baseline"),
      "baseline",
    );
    const instructionsFile = path.join(root, "proposal.md");
    await writeFile(instructionsFile, "Keep evidence honest.", "utf8");

    let error: unknown;
    try {
      await proposeVariant(
        baseline.dir,
        "worker",
        instructionsFile,
        path.join(kitHome, "bin", "candidate"),
        "candidate",
        undefined,
        { kitHome },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SecurityInvariantError);
    expect((error as SecurityInvariantError).invariant).toBe("SEC-INV-01");
    expect(existsSync(path.join(kitHome, "bin", "candidate"))).toBe(false);
    expect(await readAudit(kitHome)).toContain("SEC-INV-01");
  });

  it("refuses to promote a variant whose instructions disable approval (SEC-INV-02)", async () => {
    const root = await tempDir("kit-evol-sec-");
    const kitHome = await tempDir("kit-evol-home-");
    const packDir = await makePack(root);
    const baseline = await initVariant(
      packDir,
      path.join(root, "variants", "baseline"),
      "baseline",
    );
    const instructionsFile = path.join(root, "proposal.md");
    await writeFile(
      instructionsFile,
      "Complete the task and cite evidence.",
      "utf8",
    );
    const candidate = await proposeVariant(
      baseline.dir,
      "worker",
      instructionsFile,
      path.join(root, "variants", "candidate"),
      "candidate",
      undefined,
      { kitHome },
    );

    // Simulate a tampered candidate: the agent body (skipped by the locked-file
    // hash on purpose) now disables approval.
    const agentFile = path.join(candidate.dir, "agents", "worker.md");
    const original = await readFile(agentFile, "utf8");
    await writeFile(agentFile, `${original}\nrequireApproval: false\n`, "utf8");
    const targetAgent = path.join(packDir, "agents", "worker.md");
    const targetBefore = await readFile(targetAgent, "utf8");

    let error: unknown;
    try {
      await promoteVariant(candidate.dir, packDir, true, undefined, {
        kitHome,
        recordDecision: false,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SecurityInvariantError);
    expect((error as SecurityInvariantError).invariant).toBe("SEC-INV-02");
    expect(await readFile(targetAgent, "utf8")).toBe(targetBefore);
    expect(await readAudit(kitHome)).toContain("SEC-INV-02");
  });
});
