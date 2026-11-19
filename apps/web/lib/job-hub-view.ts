/**
 * Pure derivations for the job detail hub (#107).
 *
 * The hub is the `/world?run=<id>` drawer: one job, one lifecycle, with every
 * related plane (approvals, pending apply, report, artifacts, evolution
 * cycles) one click away. These helpers keep the aggregation deterministic and
 * unit-testable; the server reads live in `job-hub.ts`.
 */

/** Drawer tabs. `hub` is the aggregate view; the rest are the existing planes. */
export type JobHubTab = "hub" | "timeline" | "activity" | "artifacts";

/**
 * Normalises a raw `?tab=` value for a job drawer. Unknown values — including
 * the list filters (`runs`, `iterations`) — fall back to the hub so legacy
 * `/runs/<id>` and `/iterations/<id>` bookmarks land on the aggregate view.
 */
export function parseJobHubTab(value: string | undefined): JobHubTab {
  return value === "timeline" || value === "activity" || value === "artifacts"
    ? value
    : "hub";
}

/** Shareable drawer link for one job and tab. */
export function jobDrawerHref(jobId: string, tab: JobHubTab = "hub"): string {
  return `/world?run=${encodeURIComponent(jobId)}&tab=${tab}`;
}

/** Artifact deep link for pack runs: selects the artifact in the drawer. */
export function runArtifactHref(
  runId: string,
  artifactId: string,
  version: number | null,
): string {
  const key = version === null ? artifactId : `${artifactId}:${version}`;
  return `/world?run=${encodeURIComponent(runId)}&tab=artifacts&artifact=${encodeURIComponent(key)}`;
}

/**
 * Iteration artifacts have no in-drawer viewer yet; the existing iteration
 * artifact endpoint serves their text, so the hub links there instead of
 * inventing a second detail surface.
 */
export function iterationArtifactHref(
  iterationId: string,
  artifactId: string,
): string {
  return `/api/iterations/${encodeURIComponent(iterationId)}/artifact?artifactId=${encodeURIComponent(artifactId)}`;
}

export type JobArtifactKind =
  | "report"
  | "diff"
  | "transcript"
  | "verification"
  | "apply"
  | "lineage";

export interface JobArtifactRef {
  artifactId: string;
  /** `null` when only the id is known (iteration task artifacts). */
  version: number | null;
  kind: JobArtifactKind;
  href: string;
}

export interface IterationTaskArtifactView {
  taskId: string;
  diffArtifactId: string | null;
  transcriptArtifactId: string | null;
  verificationArtifactId: string | null;
  applyArtifactId: string | null;
}

/**
 * Collects the artifacts an iteration produced, newest task first, as compact
 * id references. Contents are never inlined — every ref points at its own
 * artifact endpoint.
 */
export function iterationArtifactRefs(
  iterationId: string,
  tasks: readonly IterationTaskArtifactView[],
  limit = 8,
): JobArtifactRef[] {
  const refs: JobArtifactRef[] = [];
  const seen = new Set<string>();
  const push = (artifactId: string | null, kind: JobArtifactKind) => {
    if (!artifactId || seen.has(artifactId) || refs.length >= limit) {
      return;
    }
    seen.add(artifactId);
    refs.push({
      artifactId,
      version: null,
      kind,
      href: iterationArtifactHref(iterationId, artifactId),
    });
  };
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    if (!task) {
      continue;
    }
    push(task.applyArtifactId, "apply");
    push(task.verificationArtifactId, "verification");
    push(task.diffArtifactId, "diff");
    push(task.transcriptArtifactId, "transcript");
  }
  return refs;
}

/** Distinct artifacts across iteration tasks, uncapped (the header count). */
export function iterationArtifactCount(
  tasks: readonly IterationTaskArtifactView[],
): number {
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const artifactId of [
      task.applyArtifactId,
      task.verificationArtifactId,
      task.diffArtifactId,
      task.transcriptArtifactId,
    ]) {
      if (artifactId) {
        ids.add(artifactId);
      }
    }
  }
  return ids.size;
}

export interface JobSignalRefLike {
  iterationId?: string;
}

export interface JobCycleLike {
  signalRefs?: readonly JobSignalRefLike[];
}

/**
 * Cycles that consumed this job: an evolution cycle cites failed iteration
 * tasks through `signalRefs`, so the reference is the durable back-link
 * (D-52 — JSONL stays an adapter, the record is the truth).
 */
export function filterCyclesForJob<T extends JobCycleLike>(
  cycles: readonly T[],
  jobId: string,
): T[] {
  return cycles.filter((cycle) =>
    (cycle.signalRefs ?? []).some((ref) => ref.iterationId === jobId),
  );
}

export interface PendingChangeLike {
  status: string;
  changedFiles: readonly string[];
}

export interface PendingChangeCounts {
  /** Tickets still eligible for a manual apply (`skipped`). */
  pending: number;
  total: number;
  /** Distinct files touched across the pending tickets. */
  files: number;
}

export function pendingChangeCounts(
  changes: readonly PendingChangeLike[],
): PendingChangeCounts {
  const files = new Set<string>();
  for (const change of changes) {
    for (const file of change.changedFiles) {
      files.add(file);
    }
  }
  return {
    pending: changes.filter((change) => change.status === "skipped").length,
    total: changes.length,
    files: files.size,
  };
}
