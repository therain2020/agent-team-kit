import { appendActivity } from "@kit/activity";
import { CliError } from "@kit/core";
import { ApprovalService, appendOp, findOpByKey } from "@kit/store";

/**
 * `kit agent approvals decide` — compare-and-set decision over the approval
 * entity, with the op log as the idempotency ledger (plan 91 §3.6, plan 20
 * §3.3, plan 82 §11).
 *
 * The decisions' CAS and the ledger write share one transaction, so a retry
 * with the same `--idempotency-key` after a crash replays the first decision
 * instead of racing it. A stale `--version` (or a second decision on an
 * already-decided request) surfaces as `error.code = conflict` / exit 4, which
 * is exactly what an agent needs to branch on.
 */

type Store = Parameters<typeof appendActivity>[0];

export interface DecideApprovalInput {
  approvalId: string;
  status: "approved" | "rejected";
  decisionBy: string;
  reason: string;
  /** Version the caller read; omit to decide against the current version. */
  expectedVersion?: number;
  idempotencyKey?: string;
  at?: string;
}

export interface DecideApprovalResult {
  approvalId: string;
  runId: string;
  status: "approved" | "rejected";
  version: number;
  decisionBy: string;
  decisionAt: string | null;
  decisionReason: string | null;
  /** True when the idempotency ledger replayed an earlier decision. */
  duplicate: boolean;
  /** Activity event id emitted after commit (absent on ledger replay). */
  eventId?: number;
}

interface StoredDecision {
  approvalId: string;
  runId: string;
  status: "approved" | "rejected";
  version: number;
  decisionBy: string;
  decisionAt: string | null;
  decisionReason: string | null;
}

export async function decideApprovalEntity(
  store: Store,
  input: DecideApprovalInput,
): Promise<DecideApprovalResult> {
  const key = normalizeKey(input.idempotencyKey);

  const outcome = await store.sql.begin(async (tx) => {
    const approvals = new ApprovalService({ sql: tx, driver: store.driver });
    const current = await approvals.get(input.approvalId);
    if (!current) {
      throw new CliError(
        "not_found",
        `approval not found: ${input.approvalId}`,
        { hint: "run `kit agent approvals` to list queued approvals" },
      );
    }

    if (key) {
      const existing = await findOpByKey({ sql: tx }, current.workspaceId, key);
      if (existing) {
        if (
          existing.entityKind !== "approval" ||
          existing.entityId !== input.approvalId ||
          existing.op !== "approval.decide"
        ) {
          throw new CliError(
            "conflict",
            `idempotency key "${key}" is already bound to another decision`,
            {
              details: {
                entityKind: existing.entityKind,
                entityId: existing.entityId,
              },
            },
          );
        }
        return {
          kind: "replay" as const,
          data: readStoredDecision(existing.payload),
        };
      }
    }

    const expectedVersion = input.expectedVersion ?? current.version;
    const result = await approvals.decide({
      approvalId: input.approvalId,
      expectedVersion,
      status: input.status,
      decisionBy: input.decisionBy,
      decisionReason: input.reason,
      ...(input.at ? { at: input.at } : {}),
    });

    if (!result.ok) {
      if (result.code === "not_found") {
        throw new CliError(
          "not_found",
          `approval not found: ${input.approvalId}`,
        );
      }
      if (result.code === "version_conflict") {
        throw new CliError(
          "conflict",
          `approval version conflict: expected ${expectedVersion}, current ${
            result.current?.version ?? "unknown"
          }`,
          {
            hint: "re-read `kit agent approvals` and retry with --version <current version>",
            details: {
              approvalId: input.approvalId,
              expectedVersion,
              currentVersion: result.current?.version ?? null,
            },
          },
        );
      }
      throw new CliError(
        "conflict",
        `approval is ${result.current?.status ?? "not pending"}`,
        {
          details: {
            approvalId: input.approvalId,
            currentStatus: result.current?.status ?? null,
          },
        },
      );
    }

    const stored: StoredDecision = {
      approvalId: result.record.approvalId,
      runId: result.record.runId,
      status: input.status,
      version: result.record.version,
      decisionBy: result.record.decisionBy ?? input.decisionBy,
      decisionAt: result.record.decisionAt,
      decisionReason: result.record.decisionReason,
    };

    if (key) {
      const op = await appendOp(
        { sql: tx },
        {
          workspaceId: result.record.workspaceId,
          entityKind: "approval",
          entityId: input.approvalId,
          op: "approval.decide",
          actor: input.decisionBy,
          origin: "agent",
          idempotencyKey: key,
          payload: stored,
        },
      );
      if (op.entityKind !== "approval" || op.entityId !== input.approvalId) {
        throw new CliError(
          "conflict",
          `idempotency key "${key}" is already bound to another decision`,
          { details: { entityKind: op.entityKind, entityId: op.entityId } },
        );
      }
    }

    return {
      kind: "decided" as const,
      data: stored,
      workspaceId: result.record.workspaceId,
    };
  });

  if (outcome.kind === "replay") {
    return { ...outcome.data, duplicate: true };
  }

  // Emitted after commit so the world stream and `kit agent watch` observe the
  // decision. Best-effort: the decision + ledger already succeeded, and the
  // projection can be rebuilt from the activity log.
  const eventId = await appendActivity(store, {
    workspaceId: outcome.workspaceId,
    runId: outcome.data.runId,
    agentId: input.decisionBy,
    kind: "approval.decided",
    status: input.status,
    summary: input.reason || input.status,
    payload: {
      approvalId: outcome.data.approvalId,
      version: outcome.data.version,
      decisionBy: input.decisionBy,
    },
  }).catch(() => undefined);

  return {
    ...outcome.data,
    duplicate: false,
    ...(eventId !== undefined ? { eventId } : {}),
  };
}

function readStoredDecision(payload: unknown): StoredDecision {
  const value =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const status = value.status === "rejected" ? "rejected" : "approved";
  return {
    approvalId: typeof value.approvalId === "string" ? value.approvalId : "",
    runId: typeof value.runId === "string" ? value.runId : "",
    status,
    version: typeof value.version === "number" ? value.version : 0,
    decisionBy: typeof value.decisionBy === "string" ? value.decisionBy : "",
    decisionAt: typeof value.decisionAt === "string" ? value.decisionAt : null,
    decisionReason:
      typeof value.decisionReason === "string" ? value.decisionReason : null,
  };
}

function normalizeKey(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
