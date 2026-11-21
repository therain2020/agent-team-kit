import type { SqlClient } from "./db";

/**
 * Read-only reaction chain (98 §5.2 G7, §3.5; issue #261).
 *
 * Answers the six segments of the 1.0 acceptance —
 * event → rule → job → artifact → decision → rollback — from references the
 * existing planes already write:
 *
 * - job: `TriggerRun.jobId` (written by the single `startJob` entry);
 * - artifact: `iteration_tasks.*_artifact_id` / `iteration_runs.*_artifact_id`
 *   for iteration jobs, `runs → manifests → artifacts` for pack runs;
 * - decision: `approvals` rows (run-scoped or change-scoped) and the terminal
 *   `change_proposal_transitions` rows (auto-merge decisions);
 * - rollback: the `ChangeProposal.revertRef`/`revert` record, active
 *   `last_known_good` pins that reference the job's artifacts, and audited
 *   `observer.rollback` actions.
 *
 * Nothing is synthesized: a missing reference leaves the segment empty and the
 * chain incomplete. This module only reads; there is no second pipeline or
 * parallel ledger.
 */

export interface ReactionChainLink {
  /** TriggerRun job id (`iteration_id`, `run_id` or `cycle_id`). */
  jobId: string | null;
  /** TriggerRun job kind (`iteration`, `packRun`, `evolution`). */
  jobKind: string;
}

export interface ReactionChainArtifact {
  artifactId: string;
  /** Which reference produced it (`result`, `report`, `manifest`, …). */
  stage: string;
  taskId: string | null;
}

export interface ReactionChainDecision {
  /** Stable reference: `approval:<id>` or `change:<proposal>:<trigger>:<audit>`. */
  ref: string;
  kind: "approval" | "change-transition";
  /** Approval status or the resulting change state. */
  status: string;
  riskClass: string | null;
  actor: string | null;
  at: string | null;
  changeId: string | null;
  reason: string | null;
}

export interface ReactionChainRollback {
  ref: string;
  kind: "change" | "lkg" | "observer";
  detail: string | null;
}

export interface ReactionChain {
  jobId: string | null;
  jobKind: string;
  artifacts: ReactionChainArtifact[];
  decisions: ReactionChainDecision[];
  rollbacks: ReactionChainRollback[];
  /** True when artifact, decision and rollback are all answered by real refs. */
  complete: boolean;
}

export interface ReactionChainStore {
  sql: SqlClient;
}

interface ProposalRow {
  proposal_id: string;
  state: string;
  risk: string;
  approval_ref: string | null;
  source_ref: unknown;
  revert_ref: string | null;
  revert: unknown;
  created_at: string | Date;
}

interface ApprovalRow {
  approval_id: string;
  run_id: string;
  kind: string;
  status: string;
  risk_class: string | null;
  decision_by: string | null;
  decision_at: string | Date | null;
  decision_reason: string | null;
  change_id: string | null;
}

interface TransitionRow {
  proposal_id: string;
  audit_id: string;
  to_state: string;
  trigger: string;
  actor: string;
  reason: string;
  at: string | Date;
}

interface LkgRow {
  lkg_id: string;
  target_key: string;
  artifact_refs: unknown;
}

interface OpRow {
  op_id: string;
  payload: unknown;
}

const DECISION_TRIGGERS = new Set(["promote", "rollback", "block", "fail"]);

/**
 * Resolve the chain for many jobs with the shared tables read once. Callers
 * pass the TriggerRuns they already loaded, so the trace and the observer
 * timeline share one implementation instead of duplicating join logic.
 */
export async function readReactionChains(
  store: ReactionChainStore,
  workspaceId: string,
  links: readonly ReactionChainLink[],
): Promise<Map<string, ReactionChain>> {
  const sql = store.sql;
  const result = new Map<string, ReactionChain>();
  const targets = links.filter(
    (link): link is ReactionChainLink & { jobId: string } => !!link.jobId,
  );
  if (targets.length === 0) {
    return result;
  }
  const jobIds = new Set(targets.map((link) => link.jobId));

  const [proposals, approvals, transitions, lkgRows, rollbackOps] =
    await Promise.all([
      sql<ProposalRow[]>`
        SELECT proposal_id, state, risk, approval_ref, source_ref, revert_ref,
               revert, created_at
        FROM change_proposals
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC, proposal_id DESC
        LIMIT 1000
      `,
      sql<ApprovalRow[]>`
        SELECT approval_id, run_id, kind, status, risk_class, decision_by,
               decision_at, decision_reason, change_id
        FROM approvals
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at DESC, approval_id DESC
        LIMIT 2000
      `,
      sql<TransitionRow[]>`
        SELECT t.proposal_id, t.audit_id, t.to_state, t.trigger, t.actor,
               t.reason, t.at
        FROM change_proposal_transitions t
        JOIN change_proposals p ON p.proposal_id = t.proposal_id
        WHERE p.workspace_id = ${workspaceId}
        ORDER BY t.proposal_id ASC, t.sequence ASC
        LIMIT 4000
      `,
      sql<LkgRow[]>`
        SELECT lkg_id, target_key, artifact_refs
        FROM last_known_good
        WHERE workspace_id = ${workspaceId} AND status = 'active'
        ORDER BY verified_at DESC, lkg_id DESC
        LIMIT 200
      `,
      sql<OpRow[]>`
        SELECT op_id, payload
        FROM op_log
        WHERE workspace_id = ${workspaceId}
          AND entity_kind = 'observer_action'
          AND op = 'observer.rollback'
        ORDER BY seq DESC
        LIMIT 200
      `,
    ]);

  const proposalsByJob = new Map<string, ProposalRow[]>();
  for (const row of proposals) {
    const source = parseJson<Record<string, unknown> | null>(
      row.source_ref,
      null,
    );
    if (!source) {
      continue;
    }
    const sourceId = typeof source.id === "string" ? source.id : null;
    if (!sourceId || !jobIds.has(sourceId)) {
      continue;
    }
    const kind = typeof source.kind === "string" ? source.kind : "";
    if (kind !== "iteration" && kind !== "evolution") {
      continue;
    }
    const list = proposalsByJob.get(sourceId) ?? [];
    list.push(row);
    proposalsByJob.set(sourceId, list);
  }
  const approvalsByChange = new Map<string, ApprovalRow[]>();
  for (const row of approvals) {
    if (!row.change_id) {
      continue;
    }
    const list = approvalsByChange.get(row.change_id) ?? [];
    list.push(row);
    approvalsByChange.set(row.change_id, list);
  }
  const transitionsByProposal = new Map<string, TransitionRow[]>();
  for (const row of transitions) {
    const list = transitionsByProposal.get(row.proposal_id) ?? [];
    list.push(row);
    transitionsByProposal.set(row.proposal_id, list);
  }

  for (const link of targets) {
    const { jobId, jobKind } = link;
    const artifacts = await loadArtifacts(sql, jobId, jobKind);
    const artifactIds = new Set(artifacts.map((item) => item.artifactId));
    const linkedProposals = proposalsByJob.get(jobId) ?? [];

    const jobProposalIds = new Set(
      linkedProposals.map((proposal) => proposal.proposal_id),
    );
    const decisions: ReactionChainDecision[] = [];
    const seenDecisions = new Set<string>();
    for (const approval of approvals) {
      const linked =
        approval.run_id === jobId ||
        (approval.change_id !== null && jobProposalIds.has(approval.change_id));
      if (!linked) {
        continue;
      }
      pushDecision(decisions, seenDecisions, approvalDecision(approval));
    }
    for (const proposal of linkedProposals) {
      for (const approval of approvalsByChange.get(proposal.proposal_id) ??
        []) {
        pushDecision(decisions, seenDecisions, approvalDecision(approval));
      }
      for (const transition of transitionsByProposal.get(
        proposal.proposal_id,
      ) ?? []) {
        if (!DECISION_TRIGGERS.has(transition.trigger)) {
          continue;
        }
        pushDecision(decisions, seenDecisions, {
          ref: `change:${proposal.proposal_id}:${transition.trigger}:${transition.audit_id}`,
          kind: "change-transition",
          status: transition.to_state,
          riskClass: proposal.risk,
          actor: transition.actor,
          at: toIso(transition.at),
          changeId: proposal.proposal_id,
          reason: transition.reason || null,
        });
      }
    }

    const rollbacks: ReactionChainRollback[] = [];
    const seenRollbacks = new Set<string>();
    for (const proposal of linkedProposals) {
      const revert = proposalRollback(proposal);
      if (revert) {
        pushRollback(rollbacks, seenRollbacks, revert);
      }
    }
    for (const lkg of lkgRows) {
      const refs = parseJson<unknown[]>(lkg.artifact_refs, []);
      const matched =
        lkg.target_key === jobId ||
        refs.some((ref) => typeof ref === "string" && artifactIds.has(ref));
      if (!matched) {
        continue;
      }
      pushRollback(rollbacks, seenRollbacks, {
        ref: `lkg:${lkg.lkg_id}`,
        kind: "lkg",
        detail: lkg.target_key,
      });
    }
    const jobRefs = new Set([jobId, ...artifactIds]);
    for (const op of rollbackOps) {
      const payload = parseJson<Record<string, unknown>>(op.payload, {});
      const targetRef =
        typeof payload.targetRef === "string" ? payload.targetRef : "";
      const reference =
        typeof payload.reference === "string" ? payload.reference : "";
      if (!mentions(jobRefs, targetRef) && !mentions(jobRefs, reference)) {
        continue;
      }
      pushRollback(rollbacks, seenRollbacks, {
        ref: `observer:${op.op_id}`,
        kind: "observer",
        detail: [targetRef, reference].filter(Boolean).join(" -> ") || null,
      });
    }

    artifacts.sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    decisions.sort(compareDecisions);
    rollbacks.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.ref.localeCompare(right.ref),
    );
    result.set(jobId, {
      jobId,
      jobKind,
      artifacts,
      decisions,
      rollbacks,
      complete:
        artifacts.length > 0 && decisions.length > 0 && rollbacks.length > 0,
    });
  }
  return result;
}

/** Empty chain for a job with no refs; used by callers as a safe default. */
export function emptyReactionChain(
  jobId: string | null,
  jobKind: string,
): ReactionChain {
  return {
    jobId,
    jobKind,
    artifacts: [],
    decisions: [],
    rollbacks: [],
    complete: false,
  };
}

async function loadArtifacts(
  sql: SqlClient,
  jobId: string,
  jobKind: string,
): Promise<ReactionChainArtifact[]> {
  const found: ReactionChainArtifact[] = [];
  if (jobKind === "iteration") {
    const tasks = await sql<
      Array<{
        task_id: string;
        result_artifact_id: string | null;
        diff_artifact_id: string | null;
        transcript_artifact_id: string | null;
        apply_artifact_id: string | null;
      }>
    >`
      SELECT task_id, result_artifact_id, diff_artifact_id,
             transcript_artifact_id, apply_artifact_id
      FROM iteration_tasks
      WHERE iteration_id = ${jobId}
      ORDER BY task_id ASC
    `;
    for (const row of tasks) {
      pushArtifact(found, row.result_artifact_id, "result", row.task_id);
      pushArtifact(found, row.diff_artifact_id, "diff", row.task_id);
      pushArtifact(
        found,
        row.transcript_artifact_id,
        "transcript",
        row.task_id,
      );
      pushArtifact(found, row.apply_artifact_id, "apply", row.task_id);
    }
    const runs = await sql<
      Array<{
        plan_artifact_id: string | null;
        report_artifact_id: string | null;
      }>
    >`
      SELECT plan_artifact_id, report_artifact_id
      FROM iteration_runs
      WHERE iteration_id = ${jobId}
      LIMIT 1
    `;
    for (const row of runs) {
      pushArtifact(found, row.plan_artifact_id, "plan", null);
      pushArtifact(found, row.report_artifact_id, "report", null);
    }
  } else if (jobKind === "packRun") {
    const rows = await sql<Array<{ artifact_id: string; stage_id: string }>>`
      SELECT a.artifact_id, m.stage_id
      FROM runs r
      JOIN manifests m ON m.run_id = r.run_id
      JOIN artifacts a ON a.manifest_id = m.manifest_id
      WHERE r.run_id = ${jobId}
      ORDER BY m.stage_id ASC, a.artifact_id ASC
    `;
    for (const row of rows) {
      pushArtifact(found, row.artifact_id, `manifest:${row.stage_id}`, null);
    }
  }
  return dedupeArtifacts(found);
}

function approvalDecision(row: ApprovalRow): ReactionChainDecision {
  return {
    ref: `approval:${row.approval_id}`,
    kind: "approval",
    status: row.status,
    riskClass: riskClassOrNull(row.risk_class),
    actor: row.decision_by ?? row.kind,
    at: toIso(row.decision_at),
    changeId: row.change_id,
    reason: row.decision_reason,
  };
}

function proposalRollback(row: ProposalRow): ReactionChainRollback | null {
  const revert = parseJson<Record<string, unknown> | null>(row.revert, null);
  const pointer =
    row.revert_ref ??
    (revert && revert.kind === "code" && typeof revert.commit === "string"
      ? `commit:${revert.commit}`
      : revert &&
          revert.kind === "instruction" &&
          typeof revert.targetDir === "string"
        ? `instruction:${revert.targetDir}`
        : null);
  if (!pointer) {
    return null;
  }
  return {
    ref: `change:${row.proposal_id}:${pointer}`,
    kind: "change",
    detail: `state=${row.state}`,
  };
}

function pushArtifact(
  list: ReactionChainArtifact[],
  artifactId: string | null,
  stage: string,
  taskId: string | null,
): void {
  if (!artifactId) {
    return;
  }
  list.push({ artifactId, stage, taskId });
}

function dedupeArtifacts(
  artifacts: ReactionChainArtifact[],
): ReactionChainArtifact[] {
  const seen = new Map<string, ReactionChainArtifact>();
  for (const artifact of artifacts) {
    const key = `${artifact.stage}:${artifact.artifactId}`;
    if (!seen.has(key)) {
      seen.set(key, artifact);
    }
  }
  return [...seen.values()].sort(
    (left, right) =>
      left.artifactId.localeCompare(right.artifactId) ||
      left.stage.localeCompare(right.stage),
  );
}

function pushDecision(
  list: ReactionChainDecision[],
  seen: Set<string>,
  decision: ReactionChainDecision,
): void {
  if (seen.has(decision.ref)) {
    return;
  }
  seen.add(decision.ref);
  list.push(decision);
}

function pushRollback(
  list: ReactionChainRollback[],
  seen: Set<string>,
  rollback: ReactionChainRollback,
): void {
  if (seen.has(rollback.ref)) {
    return;
  }
  seen.add(rollback.ref);
  list.push(rollback);
}

function compareDecisions(
  left: ReactionChainDecision,
  right: ReactionChainDecision,
): number {
  const leftAt = left.at ?? "";
  const rightAt = right.at ?? "";
  return (
    leftAt.localeCompare(rightAt) ||
    left.kind.localeCompare(right.kind) ||
    left.ref.localeCompare(right.ref)
  );
}

function mentions(refs: ReadonlySet<string>, value: string): boolean {
  if (!value) {
    return false;
  }
  for (const ref of refs) {
    if (value.includes(ref)) {
      return true;
    }
  }
  return false;
}

function riskClassOrNull(value: string | null): string | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
