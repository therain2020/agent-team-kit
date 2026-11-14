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
