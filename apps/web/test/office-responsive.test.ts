import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { floorBreakpointClass } from "../lib/office-responsive";

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("small-screen floor fallback (97 §3.1)", () => {
  it("defines complementary visibility pairs", () => {
    // Stage shows from `md` up only; the list is its inverse.
    expect(floorBreakpointClass("stage").split(" ")).toEqual([
      "hidden",
      "md:block",
    ]);
    expect(floorBreakpointClass("compactList").split(" ")).toEqual([
      "block",
      "md:hidden",
    ]);
  });

  it("appends layout classes without dropping the breakpoint pair", () => {
    expect(floorBreakpointClass("compactList", "mt-3")).toBe(
      "block md:hidden mt-3",
    );
    expect(floorBreakpointClass("stage", "relative")).toBe(
      "hidden md:block relative",
    );
  });

  it("wires the grid to md+ and the text list to below md", () => {
    const source = readSource("../components/office/factory-floor.tsx");
    expect(source).toContain('floorBreakpointClass("stage")');
    expect(source).toContain('floorBreakpointClass("compactList")');
    expect(source).toContain("OfficeListView");
  });

  it("keeps ?view=list on the same text list at every viewport", () => {
    const source = readSource("../components/office/office-scene.tsx");
    expect(source).toContain('view === "list"');
    expect(source).toContain("<OfficeListView");
  });
});
