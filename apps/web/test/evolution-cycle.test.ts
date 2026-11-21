import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CycleOptions,
  EvolutionCycleRecord,
  EvolutionRepository,
} from "@kit/evolution";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWebEvolutionCycle } from "../lib/evolution-cycle";

const previousHiddenRoot = process.env.KIT_HIDDEN_EVALS_ROOT;
const dirs: string[] = [];
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "kit-web-hidden-"));
  dirs.push(root);
  process.env.KIT_HIDDEN_EVALS_ROOT = path.join(root, "hidden-evals");
});

afterEach(async () => {
  if (previousHiddenRoot === undefined) {
    Reflect.deleteProperty(process.env, "KIT_HIDDEN_EVALS_ROOT");
  } else {
    process.env.KIT_HIDDEN_EVALS_ROOT = previousHiddenRoot;
  }
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const SUITE = `version: 1
cases:
  - id: std-1
    evidence: "evidence"
    expect:
      contains: ["[stub]"]
`;

function fakeRepo(workspaceId: string): EvolutionRepository {
  return { workspaceId } as unknown as EvolutionRepository;
}

function captureRun() {
  const calls: CycleOptions[] = [];
  const runCycle = async (options: CycleOptions) => {
    calls.push(options);
    return {
      cycleId: "cyc_test",
      decision: "skipped",
    } as unknown as EvolutionCycleRecord;
  };
  return { calls, runCycle };
}

async function runWeb(
  runCycle: (options: CycleOptions) => Promise<EvolutionCycleRecord>,
): Promise<void> {
  await runWebEvolutionCycle(
    { packDir: root, inputFile: path.join(root, "evidence.json") },
    { repo: fakeRepo("ws-web"), runCycle },
  );
}

describe("web evolution cycle hidden set", () => {
  it("passes the resolved hidden suite to the cycle and requires it", async () => {
    const suiteDir = path.join(root, "hidden-evals", "ws-web");
    await mkdir(suiteDir, { recursive: true });
    await writeFile(path.join(suiteDir, "suite.yaml"), SUITE, "utf8");

    const { calls, runCycle } = captureRun();
    await runWeb(runCycle);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.hiddenEvalsDir).toBe(suiteDir);
    expect(calls[0]?.requireHiddenEvals).toBe(true);
    expect(calls[0]?.workspaceId).toBe("ws-web");
    expect(calls[0]?.hiddenEvals).toMatchObject({
      status: "available",
      dir: suiteDir,
    });
  });

  it("marks a missing hidden suite and refuses the visible fallback", async () => {
    const { calls, runCycle } = captureRun();
    await runWeb(runCycle);

    expect(calls[0]?.hiddenEvalsDir).toBeUndefined();
    expect(calls[0]?.requireHiddenEvals).toBe(true);
    expect(calls[0]?.hiddenEvals).toMatchObject({ status: "missing" });
    expect(calls[0]?.hiddenEvals?.reason).toContain(
      "hidden eval directory missing",
    );
  });

  it("treats a directory without suite.yaml as incomplete", async () => {
    const suiteDir = path.join(root, "hidden-evals", "ws-web");
    await mkdir(suiteDir, { recursive: true });

    const { calls, runCycle } = captureRun();
    await runWeb(runCycle);

    expect(calls[0]?.hiddenEvalsDir).toBeUndefined();
    expect(calls[0]?.requireHiddenEvals).toBe(true);
    expect(calls[0]?.hiddenEvals).toMatchObject({ status: "incomplete" });
    expect(calls[0]?.hiddenEvals?.reason).toContain(
      "hidden eval suite missing",
    );
  });
});
