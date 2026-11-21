import type { CostCallRecord } from "@kit/model";
import { describe, expect, it } from "vitest";
import { composeJob } from "../src/compose";
import { draftJob } from "../src/draft";

const repoRoot = process.cwd();

function fakeSink(records: CostCallRecord[]) {
  return {
    record: (record: CostCallRecord) => {
      records.push(record);
      return record;
    },
  };
}

describe("job draft cost attribution", () => {
  it("charges a compose draft to its job id", async () => {
    const records: CostCallRecord[] = [];
    const result = await composeJob({
      kind: "agent",
      intent: "审阅发布前的引用与数据",
      packDir: "minimal",
      repoRoot,
      env: { KIT_MODEL_MODE: "stub" },
      cost: {
        workspaceId: "default",
        jobId: "job_draft_1",
        sink: fakeSink(records),
      },
    });

    expect(result.jobId).toBe("job_draft_1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "job:job_draft_1",
      scopeKind: "job",
      scopeId: "job_draft_1",
      jobId: "job_draft_1",
      source: "compose:agent",
      // Stub mode still bills an explicit untracked marker, never silence.
      tracked: false,
      costCnyMicro: 0,
    });
  });

  it("charges a job draft to the same job object", async () => {
    const records: CostCallRecord[] = [];
    const result = await draftJob({
      goal: "harden the auth flow",
      projectId: "self",
      repoRoot,
      env: { KIT_MODEL_MODE: "stub" },
      cost: {
        workspaceId: "default",
        jobId: "job_draft_2",
        sink: fakeSink(records),
      },
    });

    expect(result.jobId).toBe("job_draft_2");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      scopeKind: "job",
      jobId: "job_draft_2",
      source: "draft",
    });
  });
});
