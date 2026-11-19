import {
  type JobKind,
  type JobSummary,
  type PendingChange,
  getJob,
  listPendingChanges,
} from "@kit/job";
import type { ApprovalStatus } from "@kit/store";
import { getEvolutionRepo } from "./evolution-repo";
import {
  type JobArtifactKind,
  type JobArtifactRef,
  filterCyclesForJob,
  iterationArtifactCount,
  iterationArtifactHref,
  iterationArtifactRefs,
  jobDrawerHref,
  pendingChangeCounts,
  runArtifactHref,
} from "./job-hub-view";
import { type RunDetail, loadArtifactContent } from "./runs";
import { ensureStoreSchema, getStore } from "./store";
import { type WorldDrawerData, loadWorldDrawerData } from "./world-page";
import { atlasHref } from "./world-view";

/**
 * Server read path for the job detail hub (#107).
 *
 * A "job" is the union the world surface already tracks: a pack run (`runs`)
 * or an iteration (`iteration_runs`), keyed by the same id `/world?run=` uses.
 * The hub aggregates the planes that used to live on separate pages — approvals,
 * pending apply tickets, the report, related artifacts and evolution cycles —
 * without copying their contents: every entry is an id plus a deep link.
 *
 * Everything is built on the existing loaders (`loadWorldDrawerData`,
 * `listPendingChanges`, the approvals entity, `StoreEvolutionRepository`); no
 * second lifecycle model is introduced.
 */

export interface JobHubLinks {
  hub: string;
  timeline: string;
  activity: string;
  artifacts: string;
  atlas: string;
  approvals: string;
  evolution: string;
  traces: string;
}

export interface JobHubApprovalRef {
  requestId: string;
  status: ApprovalStatus;
  kind: string;
  stageName: string | null;
  slaDueAt: string | null;
  expiresAt: string | null;
  assignee: string | null;
}

export interface JobHubChangeRef {
  ticketId: string;
  taskId: string;
  status: string;
  risk: "low" | "medium" | "high";
  changedFiles: number;
  diffArtifactId: string | null;
  updatedAt: string;
}

export interface JobHubCycleRef {
  cycleId: string;
  decision: string;
  createdAt: string;
  agentId: string;
  packDir: string;
  taskId: string | null;
}

export interface JobHubUpstream {
  originKind: string;
  triggerId: string | null;
  triggerRunId: string | null;
  /** Deep link to the upstream job when the origin names one. */
  sourceHref: string | null;
  pack: string | null;
  project: string | null;
  workflowId: string | null;
}

export interface JobHubSummary {
  jobId: string;
  kind: "run" | "iteration";
  job: JobSummary | null;
  upstream: JobHubUpstream;
  approvals: JobHubApprovalRef[];
  pendingChanges: JobHubChangeRef[];
  pendingSummary: { pending: number; total: number; files: number };
  report: JobArtifactRef | null;
  artifacts: JobArtifactRef[];
  artifactCount: number;
  evolutionCycles: JobHubCycleRef[];
  decisions: number;
  links: JobHubLinks;
}

export interface JobHubResult {
  drawer: WorldDrawerData;
  hub: JobHubSummary | null;
}

/** Drawer payload plus the cross-plane hub, loaded together for the page. */
export async function loadJobHub(
  runId: string,
  artifactQuery?: string,
): Promise<JobHubResult> {
  const drawer = await loadWorldDrawerData(runId, artifactQuery);
  return { drawer, hub: await loadJobHubSummary(drawer) };
}

/**
 * Aggregate summary for one drawer. Returns `null` for missing jobs so the
 * drawer can render its "not found" state without a second branch.
 */
export async function loadJobHubSummary(
  drawer: WorldDrawerData,
): Promise<JobHubSummary | null> {
  if (drawer.kind === "missing") {
    return null;
  }
  await ensureStoreSchema();
  const store = getStore();
  const runId = drawer.runId;
  const kind: JobKind = drawer.kind === "iteration" ? "iteration" : "packRun";

  const [job, approvalPage, changes, cycles, artifacts] = await Promise.all([
    getJob(store, kind, runId).catch(() => null),
    store.approvals
      .list({ workspaceId: "default", runId, limit: 20, sort: "due" })
      .catch(() => null),
    listPendingChanges(store, runId).catch((): PendingChange[] => []),
    loadJobCycles(runId, drawer.kind === "iteration"),
    loadRelatedArtifacts(drawer),
  ]);

  const approvals: JobHubApprovalRef[] = (approvalPage?.items ?? []).map(
    (item) => ({
      requestId: item.approvalId,
      status: item.status,
      kind: item.kind,
      stageName: item.stageName,
      slaDueAt: item.slaDueAt,
      expiresAt: item.expiresAt,
      assignee: item.assignee,
    }),
  );

  const pendingChanges: JobHubChangeRef[] = changes.map((change) => ({
    ticketId: change.ticketId,
    taskId: change.taskId,
    status: change.status,
    risk: change.risk,
    changedFiles: change.changedFiles.length,
    diffArtifactId: change.diffArtifactId,
    updatedAt: change.updatedAt,
  }));

  const upstream = await buildUpstream(drawer, job);
  const report = buildReportRef(drawer);
  const links: JobHubLinks = {
    hub: jobDrawerHref(runId, "hub"),
    timeline: jobDrawerHref(runId, "timeline"),
    activity: jobDrawerHref(runId, "activity"),
    artifacts: jobDrawerHref(runId, "artifacts"),
    atlas: atlasHref({ runId }),
    approvals: "/approvals",
    evolution: "/evolution",
    traces: `/traces?runId=${encodeURIComponent(runId)}`,
  };

  return {
    jobId: runId,
    kind: drawer.kind,
    job,
    upstream,
    approvals,
    pendingChanges,
    pendingSummary: pendingChangeCounts(changes),
    report,
    artifacts,
    artifactCount:
      drawer.kind === "iteration"
        ? iterationArtifactCount(drawer.tasks)
        : drawer.detail.artifacts.length,
    evolutionCycles: cycles,
    decisions: drawer.kind === "run" ? drawer.detail.decisions.length : 0,
    links,
  };
}

async function buildUpstream(
  drawer: Extract<WorldDrawerData, { kind: "run" | "iteration" }>,
  job: JobSummary | null,
): Promise<JobHubUpstream> {
  const triggerRunId = job?.triggerRunId ?? null;
  const base: JobHubUpstream = {
    originKind: job?.originKind ?? "unknown",
    triggerId: job?.triggerId ?? null,
    triggerRunId,
    sourceHref: triggerRunId ? jobDrawerHref(triggerRunId, "hub") : null,
    pack: null,
    project: null,
    workflowId:
      job?.workflowId ??
      (drawer.kind === "iteration"
        ? drawer.run.workflowId
        : drawer.detail.run.workflowId),
  };
  if (drawer.kind === "iteration") {
    return { ...base, project: drawer.run.repoRoot };
  }
  return { ...base, pack: await readMissionPack(drawer.detail) };
}

function buildReportRef(drawer: WorldDrawerData): JobArtifactRef | null {
  if (drawer.kind === "iteration") {
    const artifactId = drawer.run.reportArtifactId;
    return artifactId
      ? {
          artifactId,
          version: null,
          kind: "report",
          href: iterationArtifactHref(drawer.runId, artifactId),
        }
      : null;
  }
  if (drawer.kind === "run") {
    const report = drawer.detail.report;
    return report
      ? {
          artifactId: report.artifact.artifactId,
          version: report.artifact.version,
          kind: "report",
          href: runArtifactHref(
            drawer.runId,
            report.artifact.artifactId,
            report.artifact.version,
          ),
        }
      : null;
  }
  return null;
}

/**
 * Iteration runs expose per-task artifact ids; pack runs expose their artifact
 * lineage edges around the deliverable. Both are id-only references.
 */
async function loadRelatedArtifacts(
  drawer: WorldDrawerData,
): Promise<JobArtifactRef[]> {
  if (drawer.kind === "iteration") {
    return iterationArtifactRefs(drawer.runId, drawer.tasks);
  }
  if (drawer.kind !== "run") {
    return [];
  }
  const anchor = drawer.detail.report ?? drawer.detail.artifacts.at(-1);
  if (!anchor) {
    return [];
  }
  const store = getStore();
  const [ancestry, consumers] = await Promise.all([
    store.artifactStore
      .ancestryOf(anchor.artifact.artifactId, anchor.artifact.version, {
        maxDepth: 1,
      })
      .catch(() => []),
    store.artifactStore
      .consumersOf(anchor.artifact.artifactId, anchor.artifact.version)
      .catch(() => []),
  ]);

  const refs: JobArtifactRef[] = [];
  const seen = new Set<string>();
  const push = (artifactId: string, version: number) => {
    const key = `${artifactId}:${version}`;
    if (
      seen.has(key) ||
      refs.length >= 8 ||
      (artifactId === anchor.artifact.artifactId &&
        version === anchor.artifact.version)
    ) {
      return;
    }
    seen.add(key);
    refs.push({
      artifactId,
      version,
      kind: "lineage" satisfies JobArtifactKind,
      href: runArtifactHref(drawer.runId, artifactId, version),
    });
  };
  for (const node of ancestry) {
    push(node.artifactId, node.version);
  }
  for (const ref of consumers) {
    push(ref.artifactId, ref.version);
  }
  return refs;
}

async function loadJobCycles(
  runId: string,
  enabled: boolean,
): Promise<JobHubCycleRef[]> {
  if (!enabled) {
    // Evolution signal refs only ever cite iteration tasks (85 / #186).
    return [];
  }
  try {
    const repo = await getEvolutionRepo();
    const cycles = await repo.listCycles(200);
    return filterCyclesForJob(cycles, runId)
      .slice(0, 8)
      .map((cycle) => {
        const ref = (cycle.signalRefs ?? []).find(
          (signal) => signal.iterationId === runId,
        );
        return {
          cycleId: cycle.cycleId,
          decision: cycle.decision,
          createdAt: cycle.createdAt,
          agentId: cycle.agentId,
          packDir: cycle.packDir,
          taskId: ref?.taskId ?? null,
        };
      });
  } catch {
    // Cycles are auxiliary evidence: never break the hub when unavailable.
    return [];
  }
}

/**
 * Pack runs persist their pack on the `mission-assignment` artifact. Reading
 * it is best-effort — historical runs without one simply show no pack.
 */
async function readMissionPack(detail: RunDetail): Promise<string | null> {
  const mission = [...detail.artifacts]
    .reverse()
    .find((view) => view.manifest?.stageId.endsWith(":mission-assignment"));
  if (!mission) {
    return null;
  }
  const content = await loadArtifactContent(
    mission.artifact,
    undefined,
    20_000,
  );
  if (content.unavailable || !content.text) {
    return null;
  }
  try {
    const parsed = JSON.parse(content.text) as { packDir?: unknown };
    return typeof parsed.packDir === "string" && parsed.packDir
      ? parsed.packDir
      : null;
  } catch {
    return null;
  }
}
