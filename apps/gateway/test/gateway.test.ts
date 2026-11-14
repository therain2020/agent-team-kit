import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  githubEventType,
  normalizeGeneric,
  normalizeGithub,
  normalizeSentry,
  sentryEventType,
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

describe("sentry normalization", () => {
  it("maps integration-platform issue webhooks", () => {
    const normalized = normalizeSentry(
      {
        action: "created",
        installation: { uuid: "install-1" },
        data: {
          issue: {
            id: "4501",
            shortId: "KIT-7",
            title: "TypeError: cannot read properties of undefined",
            culprit: "apps/web/lib/manager.ts in handleChat",
            level: "error",
            status: "unresolved",
            url: "https://sentry.example/issues/4501/",
            count: 12,
            firstSeen: "2026-11-15T01:00:00Z",
            lastSeen: "2026-11-15T02:00:00Z",
            project: { slug: "agent-team-kit", name: "Agent Team Kit" },
            tags: [
              ["environment", "production"],
              ["release", "0.9.0"],
            ],
          },
        },
      },
      { resource: "issue", workspaceId: "default" },
    );
    expect(normalized?.event.type).toBe("sentry.issue.created");
    expect(normalized?.event.idempotencyKey).toBe(
      "sentry:4501:sentry.issue.created",
    );
    expect(normalized?.payload).toMatchObject({
      source: "sentry",
      issueId: "4501",
      shortId: "KIT-7",
      level: "error",
      project: "agent-team-kit",
      environment: "production",
      release: "0.9.0",
      count: 12,
    });
  });

  it("maps legacy issue alerts and keeps the stack tail bounded", () => {
    const normalized = normalizeSentry({
      id: "7",
      project_name: "Agent Team Kit",
      message: "Error: boom",
      culprit: "apps/runtime/src/router.ts",
      level: "error",
      url: "https://sentry.example/issues/7/",
      triggered_rule: "New issue",
      event: {
        event_id: "abc123",
        title: "Error: boom",
        exception: {
          values: [
            {
              type: "Error",
              value: "boom",
              stacktrace: {
                frames: [
                  { filename: "apps/runtime/a.ts", lineno: 1 },
                  { filename: "apps/runtime/src/router.ts", lineno: 42 },
                ],
              },
            },
          ],
        },
        tags: [["environment", "staging"]],
      },
    });
    expect(normalized?.event.type).toBe("sentry.issue.alert");
    expect(normalized?.event.idempotencyKey).toBe(
      "sentry:7:sentry.issue.alert:abc123",
    );
    expect(normalized?.payload).toMatchObject({
      issueId: "7",
      title: "Error: boom",
      eventId: "abc123",
      environment: "staging",
      triggeredRule: "New issue",
    });
    expect(normalized?.payload.exception).toBe(
      "Error: boom (apps/runtime/src/router.ts:42)",
    );
  });

  it("maps metric alerts and ignores unknown resources", () => {
    expect(sentryEventType("metric_alert", "critical", {})).toBe(
      "sentry.metric_alert.critical",
    );
    expect(sentryEventType("issue", "deleted", {})).toBeNull();
    expect(sentryEventType("unknown", "created", {})).toBeNull();
    expect(normalizeSentry({ action: "deleted" }, { resource: "issue" })).toBe(
      null,
    );
  });
});

describe("sentry signature", () => {
  it("verifies the raw hex Sentry-Hook-Signature without a prefix", () => {
    const secret = "sentry-secret";
    const body = JSON.stringify({ action: "created" });
    const header = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmac(secret, body, header)).toBe(true);
    expect(verifyHmac(secret, `${body} `, header)).toBe(false);
  });
});
