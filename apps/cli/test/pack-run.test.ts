import { buildPackRun, loadPack } from "@kit/pack";
import { describe, expect, it } from "vitest";

describe("pack run builder", () => {
  it("builds stages in workflow order", async () => {
    const loaded = await loadPack("packs/tech-radar");
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("\n"));
    }

    const built = await buildPackRun(loaded, {
      workflow: "daily-radar",
      stub: true,
    });

    expect(built.workflow.id).toBe("daily-radar");
    expect(built.input.stages).toHaveLength(5);
    expect(built.input.stages[0]?.type).toBe("workflow");

    const writer = built.input.stages.find(
      (stage) => stage.stageName === "synthesize",
    );
    expect(writer?.agentId).toBe("writer");
    expect(writer?.instructions).toContain("You are the writer");

    const review = built.input.stages.find(
      (stage) => stage.stageName === "review",
    );
    expect(review?.gate?.dimensions.citations?.threshold).toBe(0.95);
    expect(review?.revision?.agentId).toBe("writer");

    const deliver = built.input.stages.find(
      (stage) => stage.stageName === "deliver",
    );
    expect(deliver?.inputFromStageId).toBe(`${built.input.runId}:synthesize`);

    expect(built.input.stub).toBe(true);
  });
});
