import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHiddenSuite, selectHiddenChunk } from "../src/hidden";
import {
  createEvalSnapshot,
  findPreviousEvalSnapshot,
  verifyEvalSnapshot,
} from "../src/snapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack(): Promise<{ root: string; packDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-snapshot-"));
  roots.push(root);
  const packDir = path.join(root, "pack");
  await mkdir(path.join(packDir, "evals", "visible"), { recursive: true });
  await mkdir(path.join(packDir, "fixtures"), { recursive: true });
  await writeFile(
    path.join(packDir, "evals", "visible", "rubrics.yaml"),
    "version: 1\nrubrics:\n  radar:\n    dimensions: {}\n",
    "utf8",
  );
  await writeFile(
    path.join(packDir, "fixtures", "case.json"),
    '{"case":1}\n',
    "utf8",
  );
  return { root, packDir };
}

describe("frozen eval snapshots", () => {
  it("copies evals and fixtures outside the pack and verifies hashes", async () => {
    const { root, packDir } = await makePack();
    const cyclesRoot = path.join(root, "cycles");

    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_test",
      packDir,
      cyclesRoot,
      freeze: false,
    });

    expect(snapshot.dir).toBe(path.join(cyclesRoot, "cyc_test", "eval"));
    expect(
      existsSync(path.join(snapshot.dir, "evals", "visible", "rubrics.yaml")),
    ).toBe(true);
    expect(existsSync(path.join(snapshot.dir, "fixtures", "case.json"))).toBe(
      true,
    );
    expect(snapshot.manifest.sources.map((file) => file.path)).toEqual([
      "evals/visible/rubrics.yaml",
      "fixtures/case.json",
    ]);
    expect(snapshot.manifest.hidden).toEqual({ available: false });

    const verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(true);
    expect(verification.manifestHash).toBe(snapshot.manifestHash);
  });

  it("detects changed, added and manifest-tampered files", async () => {
    const { root, packDir } = await makePack();
    const cyclesRoot = path.join(root, "cycles");
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_tamper",
      packDir,
      cyclesRoot,
      freeze: false,
    });

    await writeFile(
      path.join(snapshot.dir, "evals", "visible", "rubrics.yaml"),
      "tampered\n",
      "utf8",
    );
    let verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContain("evals/visible/rubrics.yaml");

    await writeFile(
      path.join(snapshot.dir, "evals", "extra.yaml"),
      "extra\n",
      "utf8",
    );
    verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.mismatches).toContain("unexpected:evals/extra.yaml");

    await writeFile(
      path.join(snapshot.dir, "manifest.sha256"),
      `${"0".repeat(64)}\n`,
      "utf8",
    );
    verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.mismatches).toContain("manifest.sha256");
  });

  it("refuses a snapshot root inside the pack", async () => {
    const { packDir } = await makePack();
    await expect(
      createEvalSnapshot({
        cycleId: "cyc_bad",
        packDir,
        cyclesRoot: path.join(packDir, "cycles"),
      }),
    ).rejects.toThrow(/outside the pack directory/);
  });

  it("freezes the rotated hidden subset and records the rotation", async () => {
    const { root, packDir } = await makePack();
    const cyclesRoot = path.join(root, "cycles");
    const hiddenDir = path.join(root, "hidden");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(
      path.join(hiddenDir, "suite.yaml"),
      `version: 1
rotation:
  periodDays: 7
  size: 1
cases:
  - id: hidden-a
    evidence: "alpha evidence"
    expect: { contains: ["alpha"] }
  - id: hidden-b
    evidence: "beta evidence"
    expect: { contains: ["beta"] }
`,
      "utf8",
    );

    const now = new Date("2026-01-01T00:00:00.000Z");
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_hidden",
      packDir,
      cyclesRoot,
      hiddenEvalsDir: hiddenDir,
      workspaceId: "ws-test",
      now,
      freeze: false,
    });

    const expected = selectHiddenChunk(await loadHiddenSuite(hiddenDir), now);
    const plan = snapshot.manifest.hidden;
    expect(plan?.available).toBe(true);
    if (!plan || !plan.available) {
      throw new Error("hidden plan missing");
    }
    expect(plan.selectedCaseIds).toEqual(expected.selectedCaseIds);
    expect(plan.selectedCaseIds).toHaveLength(1);
    expect(existsSync(path.join(snapshot.dir, "hidden", "suite.yaml"))).toBe(
      true,
    );

    const audit = await readFile(
      path.join(cyclesRoot, "hidden-audit.jsonl"),
      "utf8",
    );
    const events = audit
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("select");
    expect(events[0]?.workspaceId).toBe("ws-test");
    expect(events[0]?.selectedCaseIds).toEqual(expected.selectedCaseIds);

    const verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(true);
  });

  it("rejects a hidden suite without suite.yaml", async () => {
    const { root, packDir } = await makePack();
    const hiddenDir = path.join(root, "hidden");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(path.join(hiddenDir, "case.json"), "{}\n", "utf8");

    await expect(
      createEvalSnapshot({
        cycleId: "cyc_hidden_bad",
        packDir,
        cyclesRoot: path.join(root, "cycles"),
        hiddenEvalsDir: hiddenDir,
      }),
    ).rejects.toThrow(/suite missing/);
  });

  it("refuses a hidden suite inside the pack", async () => {
    const { packDir } = await makePack();
    const hiddenDir = path.join(packDir, "hidden-evals");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(
      path.join(hiddenDir, "suite.yaml"),
      'version: 1\ncases:\n  - id: x\n    evidence: "x"\n',
      "utf8",
    );

    await expect(
      createEvalSnapshot({
        cycleId: "cyc_hidden_inside",
        packDir,
        cyclesRoot: path.join(packDir, "..", "cycles"),
        hiddenEvalsDir: hiddenDir,
      }),
    ).rejects.toThrow(/outside the pack/);
  });

  it("finds the latest previous snapshot", async () => {
    const { root, packDir } = await makePack();
    const cyclesRoot = path.join(root, "cycles");
    await createEvalSnapshot({
      cycleId: "cyc_a",
      packDir,
      cyclesRoot,
      freeze: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await createEvalSnapshot({
      cycleId: "cyc_b",
      packDir,
      cyclesRoot,
      freeze: false,
    });

    const previous = await findPreviousEvalSnapshot({
      cyclesRoot,
      excludeCycleId: "cyc_b",
    });
    expect(previous?.manifest.cycleId).toBe("cyc_a");
  });

  it("marks frozen files read-only", async () => {
    const { root, packDir } = await makePack();
    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_frozen",
      packDir,
      cyclesRoot: path.join(root, "cycles"),
    });
    const info = await stat(
      path.join(snapshot.dir, "evals", "visible", "rubrics.yaml"),
    );
    expect(info.mode & 0o200).toBe(0);
  });
});
