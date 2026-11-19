import { describe, expect, it } from "vitest";
import {
  applyMissionPrefill,
  missionPrefillForAgent,
} from "../lib/mission-prefill";

const OPTIONS = {
  managers: ["manager", "manager-2"],
  sellers: ["seller-1", "seller-2"],
  builders: ["builder-1", "builder-2"],
  specialists: ["spec-1"],
};

const BASE = {
  workflow: "demo",
  manager: "manager",
  sellers: ["seller-1"],
  builders: ["builder-1"],
  specialists: ["spec-1"],
  acceptance: "ship it",
};

describe("mission prefill from a station", () => {
  it("maps each role onto its mission slot", () => {
    expect(
      missionPrefillForAgent({ id: "boss", isManager: true, role: "manager" }),
    ).toEqual({ manager: "boss" });
    expect(
      missionPrefillForAgent({
        id: "seller-2",
        isManager: false,
        role: "seller",
      }),
    ).toEqual({ sellers: ["seller-2"] });
    expect(
      missionPrefillForAgent({
        id: "builder-2",
        isManager: false,
        role: "builder",
      }),
    ).toEqual({ builders: ["builder-2"] });
    expect(
      missionPrefillForAgent({
        id: "spec-1",
        isManager: false,
        role: "specialist",
      }),
    ).toEqual({ specialists: ["spec-1"] });
  });

  it("leaves the selection untouched when there is no prefill", () => {
    expect(applyMissionPrefill(BASE, undefined, OPTIONS)).toBe(BASE);
  });

  it("overrides single-valued slots and unions multi-valued slots", () => {
    const next = applyMissionPrefill(
      BASE,
      {
        manager: "manager-2",
        sellers: ["seller-2"],
        builders: ["builder-2"],
        specialists: ["spec-1"],
      },
      OPTIONS,
    );
    expect(next.manager).toBe("manager-2");
    expect(next.sellers).toEqual(["seller-2"]);
    expect(next.builders).toEqual(["builder-1", "builder-2"]);
    expect(next.specialists).toEqual(["spec-1"]);
  });

  it("drops ids that are not valid options for the pack", () => {
    const next = applyMissionPrefill(
      BASE,
      {
        manager: "ghost",
        sellers: ["ghost"],
        builders: ["ghost"],
        specialists: ["ghost"],
      },
      OPTIONS,
    );
    expect(next.manager).toBe("manager");
    expect(next.sellers).toEqual(["seller-1"]);
    expect(next.builders).toEqual(["builder-1"]);
    expect(next.specialists).toEqual(["spec-1"]);
  });

  it("does not mutate the composed draft", () => {
    const draft = { ...BASE, builders: ["builder-1"] };
    applyMissionPrefill(draft, { builders: ["builder-2"] }, OPTIONS);
    expect(draft.builders).toEqual(["builder-1"]);
  });
});
