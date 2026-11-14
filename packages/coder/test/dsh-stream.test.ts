import { describe, expect, it } from "vitest";
import { DshStreamParser } from "../src/dsh-stream";
import type { CoderStreamEvent } from "../src/types";

const lines = [
  { type: "session", sessionId: "s-1" },
  { type: "status", phase: "turn_start", turn: 1 },
  { type: "status", phase: "step_start", turn: 1, step: 1 },
  { type: "thinking", text: "I should inspect the file." },
  { type: "text", text: "Inspecting the file now." },
  {
    type: "tool_call",
    callId: "c1",
    tool: "read",
    input: { file_path: "apps/web/lib/runs.ts", api_key: "should-hide" },
  },
  {
    type: "tool_result",
    callId: "c1",
    status: "completed",
    result: "<content>export const x = 1;</content>",
  },
  {
    type: "status",
    phase: "step_end",
    turn: 1,
    step: 1,
    usage: { totalTokens: 100 },
  },
  { type: "status", phase: "turn_start", turn: 2 },
  { type: "status", phase: "step_start", turn: 2, step: 1 },
  {
    type: "tool_call",
    callId: "c2",
    tool: "pwsh",
    input: { command: "bun run test" },
  },
  {
    type: "tool_result",
    callId: "c2",
    status: "failed",
    result: "exit 1",
  },
  {
    type: "final",
    sessionId: "s-1",
    reason: { kind: "completed" },
    text: "Done",
  },
];

function ndjson(): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("DshStreamParser", () => {
  it("normalizes turns, tools, tokens and redacts secrets", async () => {
    const parser = new DshStreamParser({
      now: () => new Date("2026-11-15T00:00:00.000Z"),
    });
    parser.push(ndjson());
    const parsed = await parser.finish();

    expect(parsed.completed).toBe(true);
    expect(parsed.finalText).toBe("Done");
    expect(parsed.tokens).toBe(100);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.toolCalls).toBe(1);
    expect(parsed.turns[0]?.steps).toBe(1);
    expect(parsed.turns[0]?.tokens).toBe(100);
    expect(parsed.turns[1]?.toolCalls).toBe(1);

    const toolCall = parsed.events.find(
      (event) => event.kind === "tool_call" && event.callId === "c1",
    );
    expect(toolCall?.summary).toContain("apps/web/lib/runs.ts");
    const payload = toolCall?.payload as
      | { input?: Record<string, unknown> }
      | undefined;
    expect(payload?.input?.api_key).toBe("[redacted]");
    expect(
      parsed.events.some(
        (event) => event.kind === "tool_result" && event.callId === "c2",
      ),
    ).toBe(true);
  });

  it("streams events across arbitrary chunks and awaits async sinks", async () => {
    const seen: CoderStreamEvent[] = [];
    let settled = false;
    const parser = new DshStreamParser({
      onEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(event);
        settled = true;
      },
    });
    const text = ndjson();
    for (let index = 0; index < text.length; index += 17) {
      parser.push(text.slice(index, index + 17));
    }
    const parsed = await parser.finish();
    expect(seen.length).toBeGreaterThan(5);
    expect(settled).toBe(true);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.observabilityError).toBeUndefined();
  });
});
