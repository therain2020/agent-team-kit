import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  await mkdir(path.join(packDir, "evals"), { recursive: true });
  await mkdir(path.join(packDir, "fixtures"), { recursive: true });
  await writeFile(
    path.join(packDir, "evals", "rubrics.yaml"),
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
    expect(existsSync(path.join(snapshot.dir, "evals", "rubrics.yaml"))).toBe(
      true,
    );
    expect(existsSync(path.join(snapshot.dir, "fixtures", "case.json"))).toBe(
      true,
    );
    expect(snapshot.manifest.sources.map((file) => file.path)).toEqual([
      "evals/rubrics.yaml",
      "fixtures/case.json",
    ]);

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
      path.join(snapshot.dir, "evals", "rubrics.yaml"),
      "tampered\n",
      "utf8",
    );
    let verification = await verifyEvalSnapshot(snapshot.dir);
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContain("evals/rubrics.yaml");

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

  it("copies an optional hidden eval set outside the pack", async () => {
    const { root, packDir } = await makePack();
    const hiddenDir = path.join(root, "hidden");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(path.join(hiddenDir, "case.json"), "{}\n", "utf8");

    const snapshot = await createEvalSnapshot({
      cycleId: "cyc_hidden",
      packDir,
      cyclesRoot: path.join(root, "cycles"),
      hiddenEvalsDir: hiddenDir,
      freeze: false,
    });

    expect(existsSync(path.join(snapshot.dir, "hidden", "case.json"))).toBe(
      true,
    );
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
    const info = await stat(path.join(snapshot.dir, "evals", "rubrics.yaml"));
    expect(info.mode & 0o200).toBe(0);
  });
});
