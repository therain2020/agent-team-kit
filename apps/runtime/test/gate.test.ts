import { describe, expect, it } from "vitest";
import { deterministicGate } from "../src/temporal/pack-activities";

describe("deterministic gate", () => {
  it("passes a substantive draft", () => {
    expect(
      deterministicGate("A substantive draft with enough content to pass.")
        .pass,
    ).toBe(true);
  });

  it("rejects short drafts", () => {
    expect(deterministicGate("too short").pass).toBe(false);
  });

  it("rejects TODO and unresolved placeholders", () => {
    expect(
      deterministicGate("TODO: write the actual analysis here.").pass,
    ).toBe(false);
    expect(
      deterministicGate("The metric is {{metric}} and the trend is growing.")
        .pass,
    ).toBe(false);
  });
});
