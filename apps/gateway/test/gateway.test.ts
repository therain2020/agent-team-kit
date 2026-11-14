import { describe, expect, it } from "vitest";
import {
  githubEventType,
  normalizeGeneric,
  normalizeGithub,
} from "../src/normalize";
import { isFreshTimestamp, signHmac, verifyHmac } from "../src/signature";

describe("signature", () => {
  it("verifies a matching hmac and rejects a tampered body", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ type: "signal.test" });
    const signature = signHmac(secret, body);
    expect(verifyHmac(secret, body, signature)).toBe(true);
    expect(verifyHmac(secret, `${body} `, signature)).toBe(false);
    expect(verifyHmac(undefined, body, signature)).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    const now = Date.now();
    expect(isFreshTimestamp(String(now), now)).toBe(true);
    expect(isFreshTimestamp(String(now - 10 * 60 * 1000), now)).toBe(false);
  });
});

describe("normalizeGeneric", () => {
  it("creates a canonical event and keeps the payload", () => {
    const normalized = normalizeGeneric({
      type: "signal.task.failed",
      payload: { taskId: "task-1", reason: "tests failed" },
      idempotencyKey: "signal-1",
    });
    expect(normalized.event.type).toBe("signal.task.failed");
    expect(normalized.event.idempotencyKey).toBe("signal-1");
    expect(normalized.payload.taskId).toBe("task-1");
    expect(normalized.event.schemaVersion).toBe("1.0");
  });

  it("rejects an empty type", () => {
    expect(() => normalizeGeneric({ type: "" })).toThrow();
  });
});

describe("github normalization", () => {
  it("maps issues.opened to github.issue.opened", () => {
    expect(githubEventType("issues", "opened", {})).toBe("github.issue.opened");
    expect(githubEventType("issues", "closed", {})).toBeNull();
    expect(
      githubEventType("workflow_run", "completed", {
        workflow_run: { conclusion: "failure" },
      }),
    ).toBe("ci.failed");
  });

  it("normalizes an issue payload", () => {
    const normalized = normalizeGithub(
      "issues",
      "delivery-1",
      {
        action: "opened",
        repository: { full_name: "therain2020/agent-team-kit" },
        issue: {
          number: 7,
          title: "Improve the office board",
          body: "When I open the office, ...",
          state: "open",
          html_url: "https://github.com/example/7",
          labels: [{ name: "ux" }],
          user: { login: "therain2020" },
        },
      },
      { workspaceId: "default" },
    );
    expect(normalized?.event.type).toBe("github.issue.opened");
    expect(normalized?.event.idempotencyKey).toBe("github:delivery-1");
    expect(normalized?.payload.repository).toMatchObject({
      fullName: "therain2020/agent-team-kit",
    });
    expect(normalized?.payload.issue).toMatchObject({
      number: 7,
      title: "Improve the office board",
    });
  });

  it("ignores unsupported events", () => {
    expect(normalizeGithub("issues", "d", { action: "closed" })).toBeNull();
  });
});
