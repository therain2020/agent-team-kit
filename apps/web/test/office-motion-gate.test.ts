import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  floorMotionTick,
  floorTransition,
  resolveMotionEnabled,
  shouldPlayRoomWipe,
} from "../lib/pixel-events";

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("reduced motion freezes the floor (97 §3.1)", () => {
  it("hands tick 0 and no transition when motion is off or the tab is hidden", () => {
    expect(floorMotionTick(42, true, true)).toBe(42);
    expect(floorMotionTick(42, false, true)).toBe(0);
    expect(floorMotionTick(42, true, false)).toBe(0);

    const sweep = "transform 420ms steps(4, end)";
    expect(floorTransition(true, sweep)).toBe(sweep);
    expect(floorTransition(false, sweep)).toBe("none");
  });

  it("turns the OS reduced-motion preference into a frozen floor", () => {
    const enabled = resolveMotionEnabled(true, true);
    expect(enabled).toBe(false);
    expect(floorMotionTick(9, enabled, true)).toBe(0);
    expect(floorTransition(enabled, "transform 320ms steps(3, end)")).toBe(
      "none",
    );
    // User toggle off is the same frozen path.
    expect(floorMotionTick(9, resolveMotionEnabled(false, false), true)).toBe(
      0,
    );
  });

  it("skips the room wipe under reduced motion and on new-tab clicks", () => {
    const on = { motionEnabled: true, leaving: false };
    expect(shouldPlayRoomWipe({ button: 0 }, on)).toBe(true);
    expect(
      shouldPlayRoomWipe({ button: 0 }, { ...on, motionEnabled: false }),
    ).toBe(false);
    expect(shouldPlayRoomWipe({ button: 0 }, { ...on, leaving: true })).toBe(
      false,
    );
    expect(shouldPlayRoomWipe({ button: 0, defaultPrevented: true }, on)).toBe(
      false,
    );
    for (const chord of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldPlayRoomWipe({ button: 0, [chord]: true }, on)).toBe(false);
    }
    expect(shouldPlayRoomWipe({ button: 1 }, on)).toBe(false);
  });

  it("wires the gate into the floor primitives and the door", () => {
    const floor = readSource("../components/office/factory-floor.tsx");
    expect(floor).toContain(
      "floorMotionTick(ticker.tick, motionEnabled, visible)",
    );
    expect(floor).toContain("floorTransition(");
    const door = readSource("../components/pixel/pixel-world.tsx");
    expect(door).toContain("shouldPlayRoomWipe(event,");
  });
});
