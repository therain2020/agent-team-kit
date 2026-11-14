import { autopilotSchema } from "@kit/core";
import { describe, expect, it } from "vitest";
import { nextCronOccurrence } from "../src/cron";

describe("cron", () => {
  it("finds the next daily occurrence in UTC", () => {
    const next = nextCronOccurrence(
      "30 6 * * *",
      new Date("2026-11-14T05:29:00.000Z"),
      "UTC",
    );
    expect(next.toISOString()).toBe("2026-11-14T06:30:00.000Z");
  });

  it("respects a timezone", () => {
    const next = nextCronOccurrence(
      "30 6 * * *",
      new Date("2026-11-13T22:00:00.000Z"),
      "Asia/Shanghai",
    );
    expect(next.toISOString()).toBe("2026-11-13T22:30:00.000Z");
  });

  it("supports steps and lists", () => {
    const next = nextCronOccurrence(
      "*/15 9-10 * * 1",
      new Date("2026-11-16T09:07:00.000Z"),
      "UTC",
    );
    expect(next.toISOString()).toBe("2026-11-16T09:15:00.000Z");
  });

  it("rejects malformed expressions", () => {
    expect(() => nextCronOccurrence("not a cron", new Date(), "UTC")).toThrow();
  });

  it("parses iteration schedules", () => {
    const config = autopilotSchema.parse({
      version: 1,
      enabled: true,
      schedules: [],
      iterations: [
        {
          id: "system-iterate",
          cron: "0 3 * * *",
          goal: "improve the system",
          mode: "DRY_RUN",
        },
      ],
    });
    expect(config.iterations).toHaveLength(1);
    expect(config.iterations[0]?.maxTasks).toBe(2);
    expect(config.iterations[0]?.applyMode).toBe("none");
  });
});
