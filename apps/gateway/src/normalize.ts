import { type EventEnvelope, eventEnvelopeSchema, newId } from "@kit/core";

export interface NormalizedEvent {
  event: EventEnvelope;
  payload: Record<string, unknown>;
}

export interface GenericInput {
  type?: unknown;
  payload?: unknown;
  occurredAt?: unknown;
  idempotencyKey?: unknown;
  workspaceId?: unknown;
}

export interface NormalizeOptions {
  workspaceId?: string;
  now?: Date;
}

export function normalizeGeneric(
  input: GenericInput,
  options: NormalizeOptions = {},
): NormalizedEvent {
  const type = typeof input.type === "string" ? input.type.trim() : "";
  if (!type) {
    throw new Error("generic event requires a non-empty type");
  }
  const now = options.now ?? new Date();
  const occurredAt = isoOrNow(input.occurredAt, now);
  const eventId = newId("evt");
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey
      ? input.idempotencyKey
      : `generic:${eventId}`;
  const workspaceId =
    typeof input.workspaceId === "string" && input.workspaceId
      ? input.workspaceId
      : (options.workspaceId ?? "default");
  const payload =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : { value: input.payload ?? null };

  return {
    event: eventEnvelopeSchema.parse({
      eventId,
      type,
      schemaVersion: "1.0",
      occurredAt,
      receivedAt: now.toISOString(),
      workspaceId,
      idempotencyKey,
      traceId: newId("trc"),
      payloadRef: `gateway://generic/${eventId}`,
    }),
    payload,
  };
}

export function normalizeGithub(
  eventName: string,
  deliveryId: string,
  body: Record<string, unknown>,
  options: NormalizeOptions = {},
): NormalizedEvent | null {
  const action = typeof body.action === "string" ? body.action : "";
  const type = githubEventType(eventName, action, body);
  if (!type) {
    return null;
  }
  const now = options.now ?? new Date();
  const eventId = newId("evt");
  const repository = asRecord(body.repository);
  const issue = asRecord(body.issue);
  const comment = asRecord(body.comment);
  const workflowRun = asRecord(body.workflow_run);
  const pullRequest = asRecord(body.pull_request);
  const checkRun = asRecord(body.check_run);

  const payload: Record<string, unknown> = {
    source: "github",
    event: eventName,
    action,
    deliveryId,
    repository: {
      fullName: stringOr(repository.full_name),
      private: repository.private === true,
      htmlUrl: stringOr(repository.html_url),
    },
    issue: issue.number
      ? {
          number: issue.number,
          title: stringOr(issue.title),
          body: truncate(stringOr(issue.body), 20_000),
          state: stringOr(issue.state),
          htmlUrl: stringOr(issue.html_url),
          labels: labelsOf(issue.labels),
          user: stringOr(asRecord(issue.user).login),
        }
      : undefined,
    comment: comment.body
      ? {
          body: truncate(stringOr(comment.body), 10_000),
          htmlUrl: stringOr(comment.html_url),
          user: stringOr(asRecord(comment.user).login),
        }
      : undefined,
    workflowRun: workflowRun.id
      ? {
          id: workflowRun.id,
          name: stringOr(workflowRun.name),
          conclusion: stringOr(workflowRun.conclusion),
          status: stringOr(workflowRun.status),
          htmlUrl: stringOr(workflowRun.html_url),
          headSha: stringOr(workflowRun.head_sha),
          headBranch: stringOr(workflowRun.head_branch),
        }
      : undefined,
    pullRequest: pullRequest.number
      ? {
          number: pullRequest.number,
          title: stringOr(pullRequest.title),
          body: truncate(stringOr(pullRequest.body), 20_000),
          htmlUrl: stringOr(pullRequest.html_url),
          headSha: stringOr(asRecord(pullRequest.head).sha),
        }
      : undefined,
    checkRun: checkRun.id
      ? {
          id: checkRun.id,
          name: stringOr(checkRun.name),
          conclusion: stringOr(checkRun.conclusion),
          htmlUrl: stringOr(checkRun.html_url),
        }
      : undefined,
  };

  return {
    event: eventEnvelopeSchema.parse({
      eventId,
      type,
      schemaVersion: "1.0",
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      workspaceId: options.workspaceId ?? "default",
      idempotencyKey: `github:${deliveryId}`,
      traceId: newId("trc"),
      payloadRef: `gateway://github/${deliveryId}`,
    }),
    payload,
  };
}

export interface SentryNormalizeOptions extends NormalizeOptions {
  /** Value of the `Sentry-Hook-Resource` header for integration-platform webhooks. */
  resource?: string | null;
}

/**
 * Sentry delivers two webhook shapes: the Integration Platform envelope
 * (`{action, data:{issue|event}, installation}` with a `Sentry-Hook-Resource`
 * header) and the legacy issue-alert payload (`{id, event, triggered_rule}`).
 * Both are reduced to the same bounded payload; alert text never becomes input.
 */
export function normalizeSentry(
  body: Record<string, unknown>,
  options: SentryNormalizeOptions = {},
): NormalizedEvent | null {
  const resource = (options.resource ?? "").toLowerCase();
  const action = stringOr(body.action).toLowerCase();
  const kind = sentryEventType(resource, action, body);
  if (!kind) {
    return null;
  }
  const now = options.now ?? new Date();
  const data = asRecord(body.data);
  const dataIssue = asRecord(data.issue);
  const dataEvent = asRecord(data.event);
  const legacyEvent = asRecord(body.event);
  const issue = Object.keys(dataIssue).length > 0 ? dataIssue : legacyEvent;
  const nestedEvent =
    Object.keys(dataEvent).length > 0 ? dataEvent : legacyEvent;

  const issueId =
    stringOr(issue.id) || stringOr(body.id) || stringOr(body.issue_id);
  const eventId = stringOr(nestedEvent.event_id);
  const tags = tagsOf(issue.tags);
  const project = asRecord(issue.project);

  const payload: Record<string, unknown> = {
    source: "sentry",
    resource: resource || "issue",
    action: action || kind.slice("sentry.".length),
    issueId,
    shortId: truncate(stringOr(issue.shortId), 200),
    title: truncate(
      stringOr(issue.title) ||
        stringOr(asRecord(issue.metadata).value) ||
        stringOr(body.message) ||
        stringOr(nestedEvent.title),
      2_000,
    ),
    culprit: truncate(stringOr(issue.culprit) || stringOr(body.culprit), 1_000),
    level: stringOr(issue.level) || stringOr(body.level),
    status: stringOr(issue.status),
    url: truncate(
      stringOr(issue.url) ||
        stringOr(issue.web_url) ||
        stringOr(body.url) ||
        stringOr(nestedEvent.web_url),
      1_000,
    ),
    project:
      stringOr(project.slug) ||
      stringOr(project.name) ||
      stringOr(body.project_name) ||
      stringOr(body.project),
    eventId,
    environment: tags.environment,
    release: tags.release,
    count: typeof issue.count === "number" ? issue.count : undefined,
    firstSeen: stringOr(issue.firstSeen) || stringOr(issue.first_seen),
    lastSeen: stringOr(issue.lastSeen) || stringOr(issue.last_seen),
    triggeredRule: truncate(stringOr(body.triggered_rule), 500),
    exception: exceptionSummary(asRecord(nestedEvent.exception)),
  };

  return {
    event: eventEnvelopeSchema.parse({
      eventId: newId("evt"),
      type: kind,
      schemaVersion: "1.0",
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
      workspaceId: options.workspaceId ?? "default",
      idempotencyKey: sentryIdempotencyKey(kind, issueId, eventId),
      traceId: newId("trc"),
      payloadRef: `gateway://sentry/${issueId || eventId || kind}`,
    }),
    payload,
  };
}

export function sentryEventType(
  resource: string,
  action: string,
  body: Record<string, unknown>,
): string | null {
  if (resource === "issue") {
    return ["created", "resolved", "assigned", "ignored"].includes(action)
      ? `sentry.issue.${action}`
      : null;
  }
  if (resource === "event_alert") {
    return action === "triggered" || action === "created"
      ? "sentry.event_alert.triggered"
      : null;
  }
  if (resource === "metric_alert") {
    return ["critical", "warning", "resolved"].includes(action)
      ? `sentry.metric_alert.${action}`
      : null;
  }
  if (!resource && body.id !== undefined && body.event) {
    return "sentry.issue.alert";
  }
  return null;
}

function sentryIdempotencyKey(
  kind: string,
  issueId: string,
  eventId: string,
): string {
  const subject = issueId || eventId;
  const occurrence = issueId && eventId ? `:${eventId}` : "";
  return subject ? `sentry:${subject}:${kind}${occurrence}` : `sentry:${kind}`;
}

function tagsOf(value: unknown): {
  environment: string;
  release: string;
} {
  const result = { environment: "", release: "" };
  if (!Array.isArray(value)) {
    return result;
  }
  for (const tag of value) {
    if (!Array.isArray(tag) || typeof tag[0] !== "string") {
      continue;
    }
    if (tag[0] === "environment") {
      result.environment = stringOr(tag[1]);
    }
    if (tag[0] === "release") {
      result.release = stringOr(tag[1]);
    }
  }
  return result;
}

function exceptionSummary(exception: Record<string, unknown>): string {
  const values = Array.isArray(exception.values) ? exception.values : [];
  const lines = values.flatMap((entry) => {
    const record = asRecord(entry);
    const type = stringOr(record.type);
    const value = stringOr(record.value);
    const frames = asRecord(record.stacktrace).frames;
    const frame = Array.isArray(frames) ? frames.at(-1) : undefined;
    const frameRecord = asRecord(frame);
    const location =
      stringOr(frameRecord.filename) || stringOr(frameRecord.abs_path);
    const line = frameRecord.lineno;
    const where = location
      ? ` (${location}${typeof line === "number" ? `:${line}` : ""})`
      : "";
    return type || value ? [`${type ? `${type}: ` : ""}${value}${where}`] : [];
  });
  return truncate(lines.join("\n"), 8_000);
}

export function githubEventType(
  eventName: string,
  action: string,
  body: Record<string, unknown>,
): string | null {
  if (eventName === "issues") {
    if (action === "opened") {
      return "github.issue.opened";
    }
    if (action === "reopened") {
      return "github.issue.reopened";
    }
    if (action === "labeled") {
      return "github.issue.labeled";
    }
    return null;
  }
  if (eventName === "issue_comment" && action === "created") {
    return "github.issue.comment.created";
  }
  if (eventName === "workflow_run" && action === "completed") {
    const run = asRecord(body.workflow_run);
    return run.conclusion === "failure" ? "ci.failed" : "ci.completed";
  }
  if (eventName === "check_run" && action === "completed") {
    const run = asRecord(body.check_run);
    return run.conclusion === "failure" ? "ci.failed" : "ci.completed";
  }
  if (
    eventName === "pull_request" &&
    (action === "opened" || action === "synchronize")
  ) {
    return "github.pr.updated";
  }
  return null;
}

function isoOrNow(value: unknown, now: Date): string {
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return now.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((label) => {
    if (typeof label === "string") {
      return [label];
    }
    const record = asRecord(label);
    return typeof record.name === "string" ? [record.name] : [];
  });
}
