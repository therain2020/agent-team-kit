import { describe, expect, it } from "vitest";
import {
  filterCyclesForJob,
  iterationArtifactCount,
  iterationArtifactHref,
  iterationArtifactRefs,
  jobDrawerHref,
  parseJobHubTab,
  pendingChangeCounts,
  runArtifactHref,
} from "../lib/job-hub-view";

describe("job hub tab routing (#107)", () => {
  it("opens the aggregate hub by default", () => {
    expect(parseJobHubTab("")).toBe("hub");
    expect(parseJobHubTab(undefined)).toBe("hub");
    // Legacy list filters are not drawer tabs; they fall back to the hub so
    // `/runs/<id>` and `/iterations/<id>` bookmarks land on the lifecycle.
    expect(parseJobHubTab("runs")).toBe("hub");
    expect(parseJobHubTab("iterations")).toBe("hub");
    expect(parseJobHubTab("atlas")).toBe("hub");
  });

  it("keeps the existing plane tabs", () => {
    expect(parseJobHubTab("timeline")).toBe("timeline");
    expect(parseJobHubTab("activity")).toBe("activity");
    expect(parseJobHubTab("artifacts")).toBe("artifacts");
  });

  it("builds shareable drawer links", () => {
    expect(jobDrawerHref("it_1")).toBe("/world?run=it_1&tab=hub");
    expect(jobDrawerHref("run a/b", "activity")).toBe(
      "/world?run=run%20a%2Fb&tab=activity",
    );
  });
});

describe("job hub artifact links", () => {
  it("selects a versioned artifact in the run drawer", () => {
    expect(runArtifactHref("run_1", "art_1", 2)).toBe(
      "/world?run=run_1&tab=artifacts&artifact=art_1%3A2",
    );
    expect(runArtifactHref("run_1", "art_1", null)).toBe(
      "/world?run=run_1&tab=artifacts&artifact=art_1",
    );
  });

  it("points iteration artifacts at the text endpoint", () => {
    expect(iterationArtifactHref("it_1", "art_2")).toBe(
      "/api/iterations/it_1/artifact?artifactId=art_2",
    );
  });

  it("collects newest task artifacts first, skipping nulls and dupes", () => {
    const refs = iterationArtifactRefs("it_1", [
      {
        taskId: "t1",
        diffArtifactId: "diff_1",
        transcriptArtifactId: "tr_1",
        verificationArtifactId: null,
        applyArtifactId: null,
      },
      {
        taskId: "t2",
        diffArtifactId: "diff_2",
        transcriptArtifactId: "diff_1",
        verificationArtifactId: "ver_2",
        applyArtifactId: "apply_2",
      },
    ]);

    expect(refs.map((ref) => ref.artifactId)).toEqual([
      "apply_2",
      "ver_2",
      "diff_2",
      "diff_1",
      "tr_1",
    ]);
    expect(refs.map((ref) => ref.kind)).toEqual([
      "apply",
      "verification",
      "diff",
      "transcript",
      "transcript",
    ]);
    expect(refs.every((ref) => ref.version === null)).toBe(true);
    expect(refs[0]?.href).toBe(
      "/api/iterations/it_1/artifact?artifactId=apply_2",
    );
  });

  it("counts distinct artifacts without the display cap", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      taskId: `t${index}`,
      diffArtifactId: `diff_${index}`,
      transcriptArtifactId: `tr_${index}`,
      verificationArtifactId: null,
      applyArtifactId: index === 0 ? "diff_0" : null,
    }));
    expect(iterationArtifactCount(tasks)).toBe(12);
    expect(iterationArtifactCount([])).toBe(0);
  });

  it("honours the artifact limit", () => {
    const refs = iterationArtifactRefs(
      "it_1",
      [
        {
          taskId: "t1",
          diffArtifactId: "a",
          transcriptArtifactId: "b",
          verificationArtifactId: "c",
          applyArtifactId: "d",
        },
      ],
      2,
    );
    expect(refs).toHaveLength(2);
  });
});

describe("job hub evolution back-links", () => {
  const cycles = [
    {
      cycleId: "cyc_1",
      signalRefs: [
        { iterationId: "it_1", taskId: "t1" },
        { iterationId: "it_2", taskId: "t2" },
      ],
    },
    { cycleId: "cyc_2", signalRefs: [{ iterationId: "it_2" }] },
    { cycleId: "cyc_3" },
    { cycleId: "cyc_4", signalRefs: [] },
  ];

  it("keeps only cycles that cite this job", () => {
    expect(filterCyclesForJob(cycles, "it_1").map((c) => c.cycleId)).toEqual([
      "cyc_1",
    ]);
    expect(filterCyclesForJob(cycles, "it_2").map((c) => c.cycleId)).toEqual([
      "cyc_1",
      "cyc_2",
    ]);
  });

  it("returns nothing when no cycle cites the job", () => {
    expect(filterCyclesForJob(cycles, "it_9")).toEqual([]);
    expect(filterCyclesForJob([], "it_1")).toEqual([]);
  });
});

describe("job hub pending apply counts", () => {
  it("counts pending tickets and distinct files", () => {
    expect(
      pendingChangeCounts([
        { status: "skipped", changedFiles: ["a.ts", "b.ts"] },
        { status: "skipped", changedFiles: ["b.ts"] },
        { status: "applied", changedFiles: ["c.ts"] },
      ]),
    ).toEqual({ pending: 2, total: 3, files: 3 });
  });

  it("handles an empty list", () => {
    expect(pendingChangeCounts([])).toEqual({ pending: 0, total: 0, files: 0 });
  });
});
