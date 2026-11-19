import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkHiddenDraft,
  defaultHiddenEvalsDir,
  defaultHiddenEvalsRoot,
  parseHiddenSuite,
  selectHiddenChunk,
} from "../src/hidden";

const DAY_MS = 24 * 60 * 60 * 1000;

function suiteText(size: number): string {
  const cases = [1, 2, 3, 4]
    .map(
      (index) => `  - id: case-${index}
    evidence: "evidence ${index}"
    expect:
      contains: ["evidence"]`,
    )
    .join("\n");
  return `version: 1
rotation:
  periodDays: 7
  size: ${size}
cases:
${cases}
`;
}

function alignedDate(offsetDays: number): Date {
  const base = Math.floor(
    new Date("2026-01-01T00:00:00.000Z").getTime() / (7 * DAY_MS),
  );
  return new Date((base + offsetDays) * 7 * DAY_MS + DAY_MS);
}

describe("hidden eval suites", () => {
  it("splits cases into disjoint rotation chunks", () => {
    const suite = parseHiddenSuite(suiteText(2));
    const first = selectHiddenChunk(suite, alignedDate(0));
    const second = selectHiddenChunk(suite, alignedDate(1));
    const wrapped = selectHiddenChunk(suite, alignedDate(2));

    expect(first.chunkCount).toBe(2);
    expect(first.selectedCaseIds).toHaveLength(2);
    expect(second.selectedCaseIds).toHaveLength(2);
    expect(
      first.selectedCaseIds.filter((id) => second.selectedCaseIds.includes(id)),
    ).toEqual([]);
    expect(wrapped.selectedCaseIds).toEqual(first.selectedCaseIds);
    expect(second.rotationEpoch).toBe(first.rotationEpoch + 1);
  });

  it("defaults to a single chunk covering every case", () => {
    const suite = parseHiddenSuite(suiteText(4));
    const selection = selectHiddenChunk(suite, alignedDate(0));
    expect(selection.chunkCount).toBe(1);
    expect(selection.selectedCaseIds).toHaveLength(4);
  });

  it("keeps selection stable for the same epoch and suite", () => {
    const suite = parseHiddenSuite(suiteText(1));
    const a = selectHiddenChunk(suite, alignedDate(3));
    const b = selectHiddenChunk(suite, alignedDate(3));
    expect(a).toEqual(b);
  });

  it("rejects malformed suites", () => {
    expect(() =>
      parseHiddenSuite(
        "version: 1\ncases:\n  - id: a\n    evidence: x\n  - id: a\n    evidence: y\n",
      ),
    ).toThrow(/duplicate hidden case id/);
    expect(() =>
      parseHiddenSuite(
        "version: 1\ncases:\n  - id: a\n    evidence: x\n    kind: funny\n",
      ),
    ).toThrow(/kind/);
    expect(() =>
      parseHiddenSuite(
        "version: 1\nrotation:\n  size: 9\ncases:\n  - id: a\n    evidence: x\n",
      ),
    ).toThrow(/exceeds/);
    expect(() => parseHiddenSuite("version: 2\ncases: []\n")).toThrow(
      /version/,
    );
  });

  it("checks drafts against contains and excludes", () => {
    const expectation = { contains: ["[S1]"], excludes: ["TODO"] };
    expect(checkHiddenDraft("claim [S1]", expectation)).toBe(true);
    expect(checkHiddenDraft("claim", expectation)).toBe(false);
    expect(checkHiddenDraft("claim [S1] TODO", expectation)).toBe(false);
  });

  it("derives workspace directories under the hidden root", () => {
    const root = path.join("C:", "tmp", "hidden-root");
    expect(defaultHiddenEvalsDir("ws-a", root)).toBe(path.join(root, "ws-a"));
    expect(defaultHiddenEvalsDir("../escape", root)).toBe(
      path.join(root, "..-escape"),
    );
    expect(defaultHiddenEvalsDir("  ", root)).toBe(path.join(root, "default"));
    expect(defaultHiddenEvalsRoot()).toContain("hidden-evals");
  });
});
