import { describe, expect, it } from "vitest";
import { FACTORY_ROOM_HREF } from "../lib/office-deeplink";
import {
  factoryRoomShortcut,
  floorKeyAction,
  isTypingTarget,
  officeRoomShortcut,
  stationAction,
} from "../lib/office-keys";

const typingTargets = [
  { tagName: "INPUT" },
  { tagName: "TEXTAREA" },
  { tagName: "SELECT" },
  { tagName: "DIV", isContentEditable: true },
];

describe("room switching (97 §3.5)", () => {
  it("F leaves the office for the factory floor", () => {
    expect(officeRoomShortcut({ key: "f" })).toBe(FACTORY_ROOM_HREF);
    expect(officeRoomShortcut({ key: "F" })).toBe(FACTORY_ROOM_HREF);
    expect(officeRoomShortcut({ key: "j" })).toBeNull();
  });

  it("modal surfaces keep F to themselves", () => {
    expect(officeRoomShortcut({ key: "f" }, { modalOpen: true })).toBeNull();
  });

  it("ignores chords, handled keys and typing targets", () => {
    expect(officeRoomShortcut({ key: "f", metaKey: true })).toBeNull();
    expect(officeRoomShortcut({ key: "f", ctrlKey: true })).toBeNull();
    expect(officeRoomShortcut({ key: "f", altKey: true })).toBeNull();
    expect(officeRoomShortcut({ key: "f", defaultPrevented: true })).toBeNull();
    for (const target of typingTargets) {
      expect(officeRoomShortcut({ key: "f", target })).toBeNull();
    }
  });

  it("O leaves the factory for the office, keeping producer deep links", () => {
    expect(factoryRoomShortcut({ key: "o" }, { queueMode: false })).toBe(
      "/office",
    );
    expect(factoryRoomShortcut({ key: "O" }, { queueMode: false })).toBe(
      "/office",
    );
    expect(
      factoryRoomShortcut(
        { key: "o" },
        { href: "/office?agent=seller", queueMode: false },
      ),
    ).toBe("/office?agent=seller");
    expect(factoryRoomShortcut({ key: "o" }, { queueMode: true })).toBeNull();
    expect(
      factoryRoomShortcut({ key: "o" }, { queueMode: false, dialogOpen: true }),
    ).toBeNull();
    expect(
      factoryRoomShortcut({ key: "o", ctrlKey: true }, { queueMode: false }),
    ).toBeNull();
    for (const target of typingTargets) {
      expect(
        factoryRoomShortcut({ key: "o", target }, { queueMode: false }),
      ).toBeNull();
    }
  });
});

describe("station actions (97 §3.3)", () => {
  const both = { hasRun: true, hasApproval: true };

  it("M starts a mission from the agent panel", () => {
    expect(stationAction({ key: "m" }, both)).toBe("mission");
    expect(stationAction({ key: "M" }, both)).toBe("mission");
  });

  it("R and B only fire when the agent has a run or approval", () => {
    expect(stationAction({ key: "r" }, both)).toBe("run");
    expect(stationAction({ key: "b" }, both)).toBe("approval");
    expect(
      stationAction({ key: "r" }, { hasRun: false, hasApproval: true }),
    ).toBeNull();
    expect(
      stationAction({ key: "b" }, { hasRun: true, hasApproval: false }),
    ).toBeNull();
  });

  it("ignores unbound keys, chords, handled keys and typing targets", () => {
    expect(stationAction({ key: "x" }, both)).toBeNull();
    expect(stationAction({ key: "m", metaKey: true }, both)).toBeNull();
    expect(
      stationAction({ key: "m", defaultPrevented: true }, both),
    ).toBeNull();
    for (const target of typingTargets) {
      expect(stationAction({ key: "m", target }, both)).toBeNull();
    }
  });

  it("recognises the typing targets the handlers must skip", () => {
    for (const target of typingTargets) {
      expect(isTypingTarget(target)).toBe(true);
    }
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  });
});

describe("pixel floor navigation (97 §3.1)", () => {
  const floor = { hasAgents: true, hasSelection: true };

  it("J/K walk the roster and Enter opens the selected station", () => {
    expect(floorKeyAction({ key: "j" }, floor)).toEqual({
      kind: "step",
      delta: 1,
    });
    expect(floorKeyAction({ key: "K" }, floor)).toEqual({
      kind: "step",
      delta: -1,
    });
    expect(floorKeyAction({ key: "Enter" }, floor)).toEqual({ kind: "open" });
    expect(floorKeyAction({ key: "Escape" }, floor)).toEqual({
      kind: "escape",
    });
  });

  it("Enter does nothing without a selected station", () => {
    expect(
      floorKeyAction({ key: "Enter" }, { ...floor, hasSelection: false }),
    ).toBeNull();
  });

  it("a suspended floor or empty roster ignores every key", () => {
    expect(
      floorKeyAction({ key: "j" }, { ...floor, suspended: true }),
    ).toBeNull();
    expect(
      floorKeyAction({ key: "Enter" }, { ...floor, suspended: true }),
    ).toBeNull();
    expect(
      floorKeyAction({ key: "k" }, { ...floor, hasAgents: false }),
    ).toBeNull();
    expect(
      floorKeyAction({ key: "Escape" }, { ...floor, hasAgents: false }),
    ).toBeNull();
  });

  it("keeps typing, chords and unbound keys out of the floor", () => {
    expect(floorKeyAction({ key: "j", ctrlKey: true }, floor)).toBeNull();
    expect(
      floorKeyAction({ key: "j", defaultPrevented: true }, floor),
    ).toBeNull();
    for (const target of typingTargets) {
      expect(floorKeyAction({ key: "j", target }, floor)).toBeNull();
    }
    expect(floorKeyAction({ key: "x" }, floor)).toBeNull();
  });
});
