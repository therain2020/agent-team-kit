import { describe, expect, it } from "vitest";
import { triggerMatches } from "../src/router";

describe("trigger matching", () => {
  it("matches exact types", () => {
    expect(triggerMatches("github.issue.opened", "github.issue.opened")).toBe(
      true,
    );
    expect(triggerMatches("github.issue.opened", "github.issue.closed")).toBe(
      false,
    );
  });

  it("matches prefix wildcards", () => {
    expect(triggerMatches("github.*", "github.issue.opened")).toBe(true);
    expect(triggerMatches("github.*", "ci.failed")).toBe(false);
    expect(triggerMatches("ci.*", "ci.failed")).toBe(true);
  });

  it("matches the global wildcard", () => {
    expect(triggerMatches("*", "anything.happened")).toBe(true);
  });
});
