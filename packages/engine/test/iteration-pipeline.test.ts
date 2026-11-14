import type { IterationTask, TaskPlan } from "@kit/core";
import type {
  IterationCoderResult,
  IterationInput,
  IterationVerificationResult,
} from "@kit/workflow";
import { describe, expect, it } from "vitest";
import {
  IterationCancelledError,
  type IterationPipelineActivities,
  runIterationPipeline,
} from "../src/iteration-pipeline";

function input(overrides: Partial<IterationInput> = {}): IterationInput {
  return {
    iterationId: "it_pipeline",
    workspaceId: "default",
    packDir: "packs/self-improve",
    goal: "improve the thing",
    maxTasks: 4,
    maxRepair: 1,
    runMode: "LIVE",
    applyMode: "low",
    stub: true,
    ...overrides,
  };
}

function task(
  id: string,
  risk: "low" | "medium" | "high" = "low",
): IterationTask {
  return {
    id,
    domain: "docs",
    goal: `goal ${id}`,
    acceptance: "acceptance",
    filesHint: [],
    risk,
    dependsOn: [],
  };
}

function plan(...tasks: IterationTask[]): TaskPlan {
  return { goal: "improve the thing", summary: "plan", tasks };
}

function coderResult(
  taskId: string,
  attempt: number,
  changedFiles: string[] = [`docs/${taskId}.md`],
): IterationCoderResult {
  return {
    taskId,
    coder: "command",
    ok: true,
    summary: `attempt ${attempt}`,
    changedFiles,
    diffArtifactId: `art_diff_${taskId}_${attempt}`,
    resultArtifactId: `art_result_${taskId}_${attempt}`,
    transcriptArtifactId: `art_tx_${taskId}_${attempt}`,
    sandboxDir: `/tmp/${taskId}-${attempt}`,
    baselineSha: "abc123",
    sandboxMode: "copy",
    tokens: 10,
  };
}

function verification(
  taskId: string,
  pass: boolean,
): IterationVerificationResult {
  return {
    taskId,
    pass,
    feedback: pass ? "all checks passed" : "typecheck failed",
    checks: [],
    artifactId: `art_verify_${taskId}`,
  };
}

function recordingActivities(
  overrides: Partial<IterationPipelineActivities> = {},
): IterationPipelineActivities & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    planIteration: async () => {
      calls.push("plan");
      return {
        plan: plan(task("one"), task("two", "high")),
        artifactId: "art_plan",
        tokens: 0,
        costCny: 0,
      };
    },
    runIterationCoder: async (job) => {
      calls.push(`coder:${job.task.id}:${job.attempt}`);
      return coderResult(job.task.id, job.attempt);
    },
    verifyIterationTask: async (job) => {
      calls.push(`verify:${job.task.id}`);
      return verification(job.task.id, job.task.id === "one");
    },
    classifyIterationTask: async (job) => {
      calls.push(`classify:${job.task.id}`);
      return {
        taskId: job.task.id,
        risk: job.plannedRisk,
        reasons: [],
        forbidden: false,
      };
    },
    applyIterationTask: async (job) => {
      calls.push(`apply:${job.task.id}`);
      return {
        taskId: job.task.id,
        applied: job.risk === "low",
        status: job.risk === "low" ? "applied" : "skipped",
        reason: job.risk === "low" ? "auto-applied" : "needs approval",
        ticketId: `tkt_${job.task.id}`,
        baseSha: job.baselineSha,
        artifactId: `art_apply_${job.task.id}`,
      };
    },
    cleanupIterationTask: async (job) => {
      calls.push(`cleanup:${job.sandboxDir}`);
    },
    reportIteration: async (job) => {
      calls.push(`report:${job.tasks.length}`);
      return {
        reportArtifactId: "art_report",
        fitnessArtifactId: "art_fitness",
        status: "partial",
      };
    },
    failIterationActivity: async (job) => {
      calls.push(`fail:${job.error}`);
    },
    ...overrides,
  };
}

describe("iteration pipeline", () => {
  it("runs plan → coder → verify → classify → apply → report for every task", async () => {
    const activities = recordingActivities();
    const result = await runIterationPipeline(input(), activities);

    expect(result.status).toBe("partial");
    expect(result.planArtifactId).toBe("art_plan");
    expect(result.tasks).toHaveLength(2);
    expect(activities.calls).toEqual([
      "plan",
      "coder:one:0",
      "verify:one",
      "classify:one",
      "apply:one",
      "cleanup:/tmp/one-0",
      "coder:two:0",
      "verify:two",
      "coder:two:1",
      "verify:two",
      "classify:two",
      "cleanup:/tmp/two-1",
      "report:2",
    ]);

    const [one, two] = result.tasks;
    expect(one).toMatchObject({
      taskId: "one",
      coderOk: true,
      verificationPass: true,
      applied: true,
      applyStatus: "applied",
    });
    expect(two).toMatchObject({
      taskId: "two",
      verificationPass: false,
      applied: false,
      risk: "high",
    });
  });

  it("retries the coder with verification feedback until the task passes", async () => {
    let attempts = 0;
    const activities = recordingActivities({
      planIteration: async () => ({
        plan: plan(task("fix")),
        artifactId: "art_plan",
        tokens: 0,
        costCny: 0,
      }),
      verifyIterationTask: async (job) => {
        attempts += 1;
        return verification(job.task.id, attempts > 1);
      },
    });
    const result = await runIterationPipeline(
      input({ maxRepair: 2 }),
      activities,
    );

    expect(attempts).toBe(2);
    expect(result.tasks[0]?.verificationPass).toBe(true);
    expect(result.tasks[0]?.applied).toBe(true);
  });

  it("stops cooperatively when the operator cancels the run", async () => {
    let calls = 0;
    const activities = recordingActivities({
      isIterationCancelled: async () => {
        calls += 1;
        return calls > 1;
      },
      cancelIteration: async (job) => {
        activities.calls.push(`cancel:${job.reason}`);
      },
    });

    await expect(
      runIterationPipeline(input(), activities),
    ).rejects.toBeInstanceOf(IterationCancelledError);
    expect(activities.calls).toContain("cancel:aborted by operator");
    expect(activities.calls.some((call) => call.startsWith("report:"))).toBe(
      false,
    );
  });

  it("marks the iteration failed when planning throws", async () => {
    const activities = recordingActivities({
      planIteration: async () => {
        throw new Error("planner exploded");
      },
    });

    await expect(runIterationPipeline(input(), activities)).rejects.toThrow(
      "planner exploded",
    );
    expect(activities.calls).toContain("fail:planner exploded");
  });

  it("still rejects when the terminal write-back itself fails", async () => {
    const activities = recordingActivities({
      planIteration: async () => {
        throw new Error("planner exploded");
      },
      failIterationActivity: async () => {
        throw new Error("terminal write failed");
      },
    });

    await expect(runIterationPipeline(input(), activities)).rejects.toThrow(
      "planner exploded",
    );
  });
});
