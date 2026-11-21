import {
  type AutoApproveScope,
  type RunOriginKind,
  isAutoApproveOriginEligible,
} from "@kit/core";
import type { initStore } from "@kit/store";
import {
  backfillApprovals,
  decideApprovalRecord,
  findApprovalRequest,
  recordDecision,
} from "./decisions";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Auto-approval is a policy-layer capability applied to jobs, not triggers
 * (96 §5.2). The evaluator is pure so the scope contract is testable without a
 * store; the pass below only wires store reads/writes around it.
 */

export type AutoApproveRisk = "low" | "medium" | "high";

export const POLICY_ACTOR = "policy:autopilot";

const RISK_RANK: Record<AutoApproveRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface AutoApprovalPolicy {
  /** Stable id persisted on every decision (`<pack>:auto-approve`). */
  policyId: string;
  enabled: boolean;
  scope: AutoApproveScope;
  maxRisk: AutoApproveRisk;
  maxRunCostCny?: number;
  onTimeout: "wait" | "abort";
}

export interface AutoApprovalCandidate {
  runId: string;
  requestId: string;
  originKind?: RunOriginKind;
  triggerId?: string;
  requestType: string;
  riskClass: AutoApproveRisk;
  costCny: number;
  expiresAt?: string | null;
}

export type AutoApprovalVerdict =
  | { decision: "approve"; rationale: string }
  | { decision: "abort"; rationale: string }
  | { decision: "skip"; reason: string };

export function evaluateAutoApproval(
  candidate: AutoApprovalCandidate,
  policy: AutoApprovalPolicy,
  now: Date,
): AutoApprovalVerdict {
  if (!policy.enabled) {
    return { decision: "skip", reason: "auto-approval policy is disabled" };
  }

  const origin = candidate.originKind ?? "unknown";
  // Default scope covers autonomous sources only. `scope: all` is the sole way
  // to reach manual/web/cli jobs, and it is recorded on the decision.
  if (!isAutoApproveOriginEligible(candidate.originKind, policy.scope)) {
    return {
      decision: "skip",
      reason: `origin ${origin} is outside policy scope ${policy.scope}`,
    };
  }

  // Budget exceptions need an operator decision and a limit increase;
  // auto-approving them would loop forever.
  if (candidate.requestType === "budget_exceeded") {
    return {
      decision: "skip",
      reason: "budget exceptions always need an operator",
    };
  }

  if (
    candidate.expiresAt &&
    new Date(candidate.expiresAt).getTime() < now.getTime()
  ) {
    if (policy.onTimeout === "abort") {
      return {
        decision: "abort",
        rationale: `${policy.policyId} aborted an expired approval (origin ${origin}, trigger ${candidate.triggerId ?? "none"})`,
      };
    }
    return {
      decision: "skip",
      reason: "approval request already expired",
    };
  }

  if (RISK_RANK[candidate.riskClass] > RISK_RANK[policy.maxRisk]) {
    return {
      decision: "skip",
      reason: `risk ${candidate.riskClass} exceeds policy ceiling ${policy.maxRisk}`,
    };
  }

  if (
    policy.maxRunCostCny !== undefined &&
    candidate.costCny > policy.maxRunCostCny
  ) {
    return {
      decision: "skip",
      reason: `cost ${candidate.costCny} exceeds policy ceiling ${policy.maxRunCostCny} CNY`,
    };
  }

  return {
    decision: "approve",
    rationale: `${policy.policyId} approved: origin ${origin}, scope ${policy.scope}, trigger ${candidate.triggerId ?? "none"}, risk ${candidate.riskClass}, cost ${candidate.costCny.toFixed(4)} CNY`,
  };
}

export interface AutoApprovalPackPolicy {
  /** Pack directory name; scopes the policy to that pack's workflows. */
  packDir: string;
  workflowIds: readonly string[];
  policy: AutoApprovalPolicy;
}

export interface AutoApprovalSignalInput {
  runId: string;
  requestId: string;
  decision: "approve" | "abort";
  rationale: string;
}

export interface AutoApprovalPassInput {
  store: Store;
  workspaceId: string;
  now: Date;
  packs: readonly AutoApprovalPackPolicy[];
  /**
   * Temporal signal adapter. Local runs poll the decision row instead, so the
   * adapter is a no-op in local mode.
   */
  signal: (input: AutoApprovalSignalInput) => Promise<void>;
  limit?: number;
}

export interface AutoApprovalPassResult {
  approved: string[];
  aborted: string[];
  errors: string[];
}

export async function runAutoApprovalPass(
  input: AutoApprovalPassInput,
): Promise<AutoApprovalPassResult> {
  const result: AutoApprovalPassResult = {
    approved: [],
    aborted: [],
    errors: [],
  };
  const policies = [...input.packs].sort((a, b) =>
    a.packDir.localeCompare(b.packDir),
  );
  if (!policies.some((entry) => entry.policy.enabled)) {
    return result;
  }

  const paused = await input.store.runs.list({
    status: "paused",
    limit: input.limit ?? 50,
  });
  for (const run of paused) {
    const matching = policies.filter(
      (entry) =>
        run.workflowId === undefined ||
        entry.workflowIds.includes(run.workflowId),
    );
    if (matching.length === 0) {
      continue;
    }
    const approval = await findApprovalRequest(input.store, run.runId);
    if (!approval) {
      continue;
    }
    const costCny = await runCost(input.store, run.runId);

    for (const entry of matching) {
      const verdict = evaluateAutoApproval(
        {
          runId: run.runId,
          requestId: approval.requestId,
          originKind: run.originKind,
          ...(run.triggerId ? { triggerId: run.triggerId } : {}),
          requestType: approval.requestType,
          riskClass: approval.riskClass,
          costCny,
          expiresAt: approval.expiresAt,
        },
        entry.policy,
        input.now,
      );
      if (verdict.decision === "skip") {
        continue;
      }

      const recorded = await decideApprovalRecord(input.store, {
        runId: run.runId,
        requestId: approval.requestId,
        decision: verdict.decision,
        actor: POLICY_ACTOR,
        note: verdict.rationale,
      });
      if (!recorded.ok) {
        result.errors.push(`${run.runId}: ${recorded.error}`);
        break;
      }
      if (!recorded.duplicate) {
        await recordDecision(
          input.store,
          run.runId,
          verdict.decision,
          verdict.rationale,
          {
            requestId: approval.requestId,
            actor: POLICY_ACTOR,
            riskClass: approval.riskClass,
            policyId: entry.policy.policyId,
            scope: entry.policy.scope,
            ...(run.triggerId ? { triggerId: run.triggerId } : {}),
            rationale: verdict.rationale,
          },
        );
      }

      try {
        await input.signal({
          runId: run.runId,
          requestId: approval.requestId,
          decision: verdict.decision,
          rationale: verdict.rationale,
        });
      } catch (error) {
        result.errors.push(
          `${run.runId}: signal failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }

      if (verdict.decision === "approve") {
        result.approved.push(run.runId);
      } else {
        result.aborted.push(run.runId);
      }
      break;
    }
  }
  return result;
}

/**
 * Approval SLA maintenance, extracted from the daemon so the scheduler only
 * invokes it (96 §5.1). Backfills entities for pre-upgrade paused runs, then
 * expires rows past their deadline.
 */
export async function runApprovalMaintenance(
  store: Store,
  options: { workspaceId: string; now: Date; backfillLimit?: number },
): Promise<{ expired: string[]; errors: string[] }> {
  const errors: string[] = [];
  try {
    await backfillApprovals(store, {
      workspaceId: options.workspaceId,
      ...(options.backfillLimit ? { limit: options.backfillLimit } : {}),
    });
  } catch (error) {
    errors.push(
      `approvals backfill: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const expired: string[] = [];
  try {
    const rows = await store.approvals.expireDue(options.now.toISOString());
    expired.push(...rows.map((row) => row.approvalId));
  } catch (error) {
    errors.push(
      `approvals expiry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { expired, errors };
}

async function runCost(store: Store, runId: string): Promise<number> {
  const artifacts = await store.artifactStore.listByRun(runId);
  let total = 0;
  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    total += manifest?.cost.amount ?? 0;
  }
  return total;
}
