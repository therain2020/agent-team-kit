import { describe, expect, it } from "vitest";
import {
  isNightMode,
  isQuietWindow,
  isWithinWindow,
  parseOnCallPolicy,
  parseTimeOfDay,
  timeOfDayInZone,
} from "../src/index";

function at(iso: string): Date {
  return new Date(iso);
}

describe("ops time windows", () => {
  it("parses HH:MM", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("07:30")).toBe(450);
    expect(parseTimeOfDay("24:00")).toBeNull();
    expect(parseTimeOfDay("7:30")).toBeNull();
  });

  it("reads the local minute of day in a timezone", () => {
    expect(timeOfDayInZone(at("2026-11-15T15:00:00Z"), "Asia/Shanghai")).toBe(
      23 * 60,
    );
    expect(timeOfDayInZone(at("2026-11-15T12:00:00Z"), "UTC")).toBe(12 * 60);
  });

  it("matches overnight windows", () => {
    const window = {
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };

    expect(isWithinWindow(at("2026-11-15T23:30:00Z"), window)).toBe(true);
    expect(isWithinWindow(at("2026-11-15T06:59:00Z"), window)).toBe(true);
    expect(isWithinWindow(at("2026-11-15T07:00:00Z"), window)).toBe(false);
    expect(isWithinWindow(at("2026-11-15T12:00:00Z"), window)).toBe(false);
  });

  it("does not treat identical start and end as a window", () => {
    expect(
      isWithinWindow(at("2026-11-15T23:00:00Z"), {
        start: "22:00",
        end: "22:00",
        timezone: "UTC",
      }),
    ).toBe(false);
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(
      isWithinWindow(at("2026-11-15T23:30:00Z"), {
        start: "22:00",
        end: "07:00",
        timezone: "Not/AZone",
      }),
    ).toBe(true);
  });

  it("derives night mode and quiet window from policy", () => {
    const policy = parseOnCallPolicy({
      nightMode: {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      quietWindow: { start: "12:00", end: "13:00", timezone: "UTC" },
    });

    expect(isNightMode(at("2026-11-15T23:30:00Z"), policy)).toBe(true);
    expect(isNightMode(at("2026-11-15T12:30:00Z"), policy)).toBe(false);
    expect(isQuietWindow(at("2026-11-15T12:30:00Z"), policy)).toBe(true);
    expect(isQuietWindow(at("2026-11-15T18:30:00Z"), policy)).toBe(false);
  });
});
