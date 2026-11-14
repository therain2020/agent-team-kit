import { describe, expect, it } from "vitest";
import { envRepairRounds, resolveRepairRounds } from "../src/service";

describe("repair rounds", () => {
  it("defaults to two rounds when the environment is unset", () => {
    expect(envRepairRounds({})).toBe(2);
    expect(resolveRepairRounds(undefined, {})).toBe(2);
  });

  it("uses KIT_REPAIR_ROUNDS as the default and clamps it", () => {
    expect(envRepairRounds({ KIT_REPAIR_ROUNDS: "4" })).toBe(4);
    expect(envRepairRounds({ KIT_REPAIR_ROUNDS: "9" })).toBe(5);
    expect(envRepairRounds({ KIT_REPAIR_ROUNDS: "-1" })).toBe(0);
    expect(envRepairRounds({ KIT_REPAIR_ROUNDS: "abc" })).toBe(2);
    expect(envRepairRounds({ KIT_REPAIR_ROUNDS: "" })).toBe(2);
  });

  it("lets an explicit value win over the environment", () => {
    expect(resolveRepairRounds(1, { KIT_REPAIR_ROUNDS: "4" })).toBe(1);
    expect(resolveRepairRounds(0, { KIT_REPAIR_ROUNDS: "4" })).toBe(0);
    expect(resolveRepairRounds(7, {})).toBe(5);
  });
});
