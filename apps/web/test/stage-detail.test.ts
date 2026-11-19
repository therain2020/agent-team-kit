import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_CALLS,
  MAX_TURNS,
  parseInstructions,
  parseTranscript,
  stageNameFromId,
} from "../lib/stage-detail";

describe("stage id helpers", () => {
  it("strips the run prefix and falls back to the last segment", () => {
    expect(stageNameFromId("run_1", "run_1:build")).toBe("build");
    expect(stageNameFromId("run_1", "other:write")).toBe("write");
    expect(stageNameFromId("run_1", null)).toBeNull();
    expect(stageNameFromId("run_1", "build")).toBe("build");
  });
});

describe("stage instructions parsing", () => {
  it("reads the prompt and the write-time truncation flag", () => {
    const prompt = parseInstructions(
      JSON.stringify({ kind: "stage.instructions", instructions: "Do it" }),
      "art_1",
    );
    expect(prompt).toEqual({
      artifactId: "art_1",
      text: "Do it",
      truncated: false,
      available: true,
    });
  });

  it("keeps non-JSON blobs as the prompt", () => {
    const prompt = parseInstructions("# raw prompt", null);
    expect(prompt.available).toBe(true);
    expect(prompt.text).toBe("# raw prompt");
  });

  it("marks an empty payload unavailable", () => {
    expect(parseInstructions("{}", "art_2")).toMatchObject({
      available: false,
      text: "",
    });
  });
});

describe("stage transcript parsing", () => {
  it("flattens turns and tool calls", () => {
    const transcript = parseTranscript(
      JSON.stringify({
        kind: "stage.transcript",
        toolCalls: 2,
        gateScore: 0.82,
        durationMs: 5_400,
        finalResponse: "done",
        outputArtifactId: "art_out",
        inputs: [{ artifactId: "art_in", version: 2 }],
        turns: [
          {
            index: 1,
            kind: "model",
            requestSummary: "plan",
            responseSummary: "writing",
            toolCalls: [
              {
                index: 1,
                tool: "write_file",
                argsSummary: "a.ts",
                resultSummary: "ok",
                isError: false,
              },
              {
                index: 2,
                tool: "run_tests",
                argsSummary: "",
                resultSummary: "1 failed",
                isError: true,
              },
            ],
          },
        ],
      }),
      "art_t",
    );
    expect(transcript.available).toBe(true);
    expect(transcript.toolCallCount).toBe(2);
    expect(transcript.gateScore).toBe(0.82);
    expect(transcript.durationMs).toBe(5_400);
    expect(transcript.outputArtifactId).toBe("art_out");
    expect(transcript.inputs).toEqual([{ artifactId: "art_in", version: 2 }]);
    expect(transcript.turns[0]?.toolCalls[1]).toMatchObject({
      tool: "run_tests",
      isError: true,
    });
  });

  it("caps turns and tool calls and flags truncation", () => {
    const turns = Array.from({ length: MAX_TURNS + 3 }, (_, index) => ({
      index: index + 1,
      kind: "model",
      requestSummary: "r",
      responseSummary: "s",
      toolCalls: Array.from({ length: 4 }, (_, call) => ({
        index: call,
        tool: "tool",
        argsSummary: "",
        resultSummary: "",
        isError: false,
      })),
    }));
    const transcript = parseTranscript(
      JSON.stringify({ turns, toolCalls: turns.length * 4 }),
      null,
    );
    expect(transcript.turns).toHaveLength(MAX_TURNS);
    // The metric keeps the artifact header's total; the list is capped.
    expect(transcript.toolCallCount).toBe(turns.length * 4);
    expect(transcript.turns.flatMap((turn) => turn.toolCalls).length).toBe(
      MAX_TOOL_CALLS,
    );
    expect(transcript.truncated).toBe(true);
  });

  it("degrades malformed payloads to unavailable", () => {
    expect(parseTranscript("not json", "art")).toMatchObject({
      available: false,
      turns: [],
      toolCallCount: 0,
    });
    expect(parseTranscript("[]", null).available).toBe(false);
  });

  it("falls back to counted tool calls when the header count is absent", () => {
    const transcript = parseTranscript(
      JSON.stringify({
        turns: [
          {
            toolCalls: [{ tool: "a" }, { tool: "b" }],
          },
        ],
      }),
      null,
    );
    expect(transcript.toolCallCount).toBe(2);
    expect(transcript.turns[0]?.kind).toBe("model");
    expect(transcript.turns[0]?.index).toBe(1);
  });
});
