import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IterationTask } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyIterationTask } from "../src/iteration-activities";

let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-substrate-"));
  env = {
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  };
  Object.assign(process.env, env);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

function task(): IterationTask {
  return {
    id: "t1",
    domain: "docs",
    goal: "update docs",
    acceptance: "docs updated",
    filesHint: [],
    risk: "low",
    dependsOn: [],
  };
}

async function applySubstrate(
  iterationId: string,
  changedFiles: string[],
  applyMode: "low" | "low-medium",
) {
  return applyIterationTask({
    iterationId,
    workspaceId: "default",
    repoRoot: dir,
    task: task(),
    risk: "medium",
    forbidden: false,
    verificationPass: true,
    applyMode,
    runMode: "LIVE",
    diffArtifactId: `art_diff_${iterationId}`,
    verificationArtifactId: `art_verify_${iterationId}`,
    baselineSha: "abc123",
    changedFiles,
  });
}

describe("iteration substrate boundary", () => {
  it("blocks --apply low-medium when changed files hit packs/*/agents/**", async () => {
    const result = await applySubstrate(
      "it_substrate_agents",
      ["docs/readme.md", "packs/self-improve/agents/patcher.md"],
      "low-medium",
    );
    expect(result.status).toBe("blocked");
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("agent/skill instructions");

    const store = await initStore(loadStoreConfig(env));
    try {
      const tickets = await store.sql<
        Array<{
          status: string;
          patch_artifact_id: string | null;
          error: string | null;
        }>
      >`
        SELECT status, patch_artifact_id, error FROM merge_tickets
        WHERE iteration_id = 'it_substrate_agents'
      `;
      expect(tickets[0]).toMatchObject({
        status: "blocked",
        patch_artifact_id: "art_diff_it_substrate_agents",
      });
      expect(tickets[0]?.error).toContain("agent/skill instructions");

      const events = await store.sql<Array<{ payload: unknown }>>`
        SELECT payload FROM iteration_events
        WHERE iteration_id = 'it_substrate_agents'
          AND kind = 'apply.finished'
      `;
      const payload = JSON.stringify(events[0]?.payload ?? {});
      expect(payload).toContain("change_proposal");
      expect(payload).toContain("packs/self-improve/agents/patcher.md");
      expect(payload).toContain("diffArtifactId");
      expect(payload).toContain("verificationArtifactId");
    } finally {
      await store.close();
    }
  }, 30_000);

  it("blocks --apply low when changed files hit skills/**", async () => {
    const result = await applySubstrate(
      "it_substrate_skills",
      ["skills/copywriting/SKILL.md"],
      "low",
    );
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("agent/skill instructions");
  }, 30_000);

  it("parks workflow changes as high-risk approvals, not auto-applies", async () => {
    const result = await applySubstrate(
      "it_substrate_workflows",
      ["packs/tech-radar/workflows/daily.yaml"],
      "low-medium",
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("risk high");
  }, 30_000);
});
