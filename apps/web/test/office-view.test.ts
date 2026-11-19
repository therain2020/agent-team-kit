import { describe, expect, it } from "vitest";
import {
  edgeStationId,
  rovingTabIndex,
  stepStationId,
} from "../components/office/station-nav";
import { parseOfficeView } from "../lib/office-view";

describe("office view switch", () => {
  it("defaults to the floor and accepts ?view=list", () => {
    expect(parseOfficeView(undefined)).toBe("floor");
    expect(parseOfficeView("list")).toBe("list");
    expect(parseOfficeView(["list", "factory"])).toBe("list");
    expect(parseOfficeView("unknown")).toBe("floor");
  });
});

describe("roving station navigation", () => {
  const ids = ["manager", "builder", "seller"];

  it("steps forward and backward with wrapping", () => {
    expect(stepStationId(ids, "manager", 1)).toBe("builder");
    expect(stepStationId(ids, "seller", 1)).toBe("manager");
    expect(stepStationId(ids, "manager", -1)).toBe("seller");
  });

  it("starts at the matching edge when nothing is active", () => {
    expect(stepStationId(ids, null, 1)).toBe("manager");
    expect(stepStationId(ids, null, -1)).toBe("seller");
    expect(stepStationId([], null, 1)).toBeNull();
  });

  it("jumps to the first and last station", () => {
    expect(edgeStationId(ids, "first")).toBe("manager");
    expect(edgeStationId(ids, "last")).toBe("seller");
    expect(edgeStationId([], "first")).toBeNull();
  });

  it("keeps exactly one station in the tab order", () => {
    expect(rovingTabIndex("builder", "builder", 1)).toBe(0);
    expect(rovingTabIndex("manager", "builder", 0)).toBe(-1);
    expect(rovingTabIndex("manager", null, 0)).toBe(0);
    expect(rovingTabIndex("manager", null, 1)).toBe(-1);
  });
});
