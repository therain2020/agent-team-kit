import { describe, expect, it } from "vitest";
import {
  type ApprovalTowerCard,
  bucketOf,
  groupApprovals,
  medianWait,
} from "../lib/inbox-shared";

// Local-time constructors keep the "today" boundary deterministic regardless
// of the test machine's timezone.
const NOW = new Date(2026, 10, 19, 10, 0, 0).getTime();
const DAY_END = new Date(2026, 10, 20, 0, 0, 0).getTime();
const MINUTE = 60_000;

function card(
  requestId: string,
  dueAt: string | null,
  createdAt: string,
  overrides: Partial<ApprovalTowerCard> = {},
): ApprovalTowerCard {
  return {
    requestId,
    runId: `run_${requestId}`,
    changeId: null,
    substrate: null,
    revertRef: null,
    workflowId: "demo",
    stageId: `run_${requestId}:review`,
    stageName: "review",
    kind: "gate_failure",
    requestType: "gate_failure",
    riskClass: "medium",
    summary: requestId,
    requester: "manager",
    assignee: null,
    status: "queued",
    version: 1,
    createdAt,
    dueAt,
    expiresAt: dueAt,
    draftArtifactId: null,
    draftSnippet: "",
    gate: null,
    budget: null,
    runStatus: "paused",
    ...overrides,
  };
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("approval tower SLA buckets", () => {
  it("splits overdue, within 30 minutes, today and later", () => {
    expect(bucketOf(iso(-MINUTE), NOW, DAY_END)).toBe("overdue");
    expect(bucketOf(iso(29 * MINUTE), NOW, DAY_END)).toBe("soon");
    expect(bucketOf(iso(31 * MINUTE), NOW, DAY_END)).toBe("today");
    expect(bucketOf(iso(20 * 60 * MINUTE), NOW, DAY_END)).toBe("later");
    expect(bucketOf(null, NOW, DAY_END)).toBe("later");
    expect(bucketOf("not-a-date", NOW, DAY_END)).toBe("later");
  });

  it("keeps queue depth and median wait per column", () => {
    const cards = [
      card("a", iso(-30 * MINUTE), iso(-90 * MINUTE)),
      card("b", iso(-10 * MINUTE), iso(-30 * MINUTE)),
      card("c", iso(10 * MINUTE), iso(-50 * MINUTE)),
      card("d", iso(5 * 60 * MINUTE), iso(-10 * MINUTE)),
    ];

    const groups = groupApprovals(cards, NOW);
    const byId = Object.fromEntries(groups.map((group) => [group.id, group]));

    expect(byId.overdue?.depth).toBe(2);
    expect(byId.overdue?.cards.map((entry) => entry.requestId)).toEqual([
      "a",
      "b",
    ]);
    // Median of 90m and 30m waits is 60m.
    expect(byId.overdue?.medianWaitMs).toBe(60 * MINUTE);

    expect(byId.soon?.depth).toBe(1);
    expect(byId.soon?.medianWaitMs).toBe(50 * MINUTE);
    expect(byId.today?.depth).toBe(1);
    expect(byId.later?.depth).toBe(0);
    expect(byId.later?.medianWaitMs).toBeNull();
  });

  it("uses the middle value for odd card counts", () => {
    const waits = [10, 40, 90].map((minutes, index) =>
      card(`${index}`, iso(60 * MINUTE), iso(-minutes * MINUTE)),
    );
    expect(medianWait(waits, NOW)).toBe(40 * MINUTE);
  });

  it("groups an empty queue into four empty columns", () => {
    const groups = groupApprovals([], NOW);
    expect(groups.map((group) => [group.id, group.depth])).toEqual([
      ["overdue", 0],
      ["soon", 0],
      ["today", 0],
      ["later", 0],
    ]);
  });
});
