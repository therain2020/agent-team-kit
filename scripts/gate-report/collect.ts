import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readIterationSignals, readOutcomeObservations } from "@kit/evolution";
import { createDb, loadStoreConfig } from "@kit/store";
import { isReactionSignalRecord } from "@kit/trigger";
import { checkColdStartPackage } from "../cold-start-check";
import {
  type ActivityEvidence,
  type CodeChangeEvidence,
  type ColdStartEvidence,
  type EvidenceBundle,
  type EvidenceSourceStatus,
  type EvolutionPromotionEvidence,
  type ForbiddenBlockEvidence,
  type InstalledComponentEvidence,
  type InstalledSourceEvidence,
  type InterventionEvidence,
  type ManufactureProposalEvidence,
  type ReactionSampleEvidence,
  type ReactionSignalEvidence,
  type RecoveryDrillEvidence,
  type SupervisorEvidence,
  type TriggerRunEvidence,
  buildWindow,
} from "./model";

/**
 * Local evidence collector for the 1.0 gate report (issue #135).
 *
 * Read-only by construction: it opens the SQLite store for SELECTs only,
 * parses append-only JSONL audit files and recovery drill reports, and scans
 * pack manufacture records. Missing or unreadable sources are reported as
 * such; the collector never derives a value that is not present on disk.
 */
export interface CollectOptions {
  home: string;
  repoRoot: string;
  now: string;
  days: number;
  dbPath?: string;
  packsRoot?: string;
  signalsRoot?: string;
  sourcesRoot?: string;
  reactionsPath?: string;
  supervisorStatePath?: string;
  /** Zero-config TTHW ledger (default: <home>/cold-start-tthw.json). */
  tthwPath?: string;
}

/** Probe pattern shared by S9 activity kinds and op-log lock entries. */
const CONCURRENCY_KIND = /(?:^|[.:_-])(lock|fence|lease|concurr|serializ)/i;

interface StoreEvidence {
  informationEvents: EvidenceBundle["informationEvents"];
  triggerRuns: TriggerRunEvidence[];
  manualTasks: EvidenceBundle["manualTasks"];
  codeChanges: CodeChangeEvidence[];
  runs: EvidenceBundle["runs"];
  interventions: InterventionEvidence[];
  decisionRefs: string[];
  lkgRefs: string[];
  openIncidents: string[];
  forbiddenBlocks: ForbiddenBlockEvidence[];
  recoveryDrills: RecoveryDrillEvidence[];
  evolutionPromotions: EvolutionPromotionEvidence[];
  concurrencyEvidence: ActivityEvidence[];
  factoryEvidence: ActivityEvidence[];
  workshopEvidence: ActivityEvidence[];
}

interface KitdRecord {
  at?: unknown;
  action?: unknown;
  status?: unknown;
  detail?: unknown;
}

interface RecoveryReport {
  mode?: unknown;
  script?: unknown;
  outcome?: unknown;
  finishedAt?: unknown;
  recoverySeconds?: unknown;
  checks?: Array<{ pass?: unknown }>;
}

interface JsonlRead {
  status: "ok" | "missing" | "unreadable";
  records: unknown[];
  corrupt: number;
  error: string | null;
}

export async function collectEvidence(
  options: CollectOptions,
): Promise<EvidenceBundle> {
  const window = buildWindow(options.now, options.days);
  const sources: EvidenceSourceStatus[] = [];
  const home = path.resolve(options.home);
  const repoRoot = path.resolve(options.repoRoot);
  const dbPath =
    options.dbPath ??
    process.env.KIT_LOCAL_DB ??
    path.join(home, "data", "kit.db");
  const signalsRoot = options.signalsRoot ?? path.join(home, "signals");
  const packsRoot = options.packsRoot ?? path.join(repoRoot, "packs");
  const sourcesRoot = options.sourcesRoot ?? path.join(repoRoot, "sources");
  const auditDir = path.join(home, "audit");
  const supervisorStatePath =
    options.supervisorStatePath ??
    path.join(repoRoot, ".tmp", "supervisor", "state.json");

  const store = await collectStore(dbPath, window.start, window.end);
  sources.push(store.source);

  const kitd = await readJsonl(path.join(auditDir, "kitd.jsonl"));
  const kitdRecords = kitd.records.filter(isKitdRecord);
  sources.push({
    id: "kitd-audit",
    path: path.join(auditDir, "kitd.jsonl"),
    status: kitd.status,
    records: kitdRecords.length,
    detail: sourceDetail(kitd),
  });
  const kitdInterventions = kitdRecords.flatMap((record, index) =>
    kitdIntervention(record, index, window.start, window.end),
  );

  const recovery = await collectRecoveryReports(
    auditDir,
    window.start,
    window.end,
  );
  sources.push(recovery.source);

  const manufacture = await collectManufacture(packsRoot);
  sources.push(manufacture.source);
  const components = await collectComponents(packsRoot);
  sources.push(components.source);

  const installedSources = await collectInstalledSources(sourcesRoot);
  sources.push(installedSources.source);

  const iterations = await readIterationSignals(
    path.join(signalsRoot, "iterations.jsonl"),
  );
  sources.push({
    id: "signals-iterations",
    path: iterations.path,
    status: existsSync(iterations.path) ? "ok" : "missing",
    records: iterations.signals.length,
    detail:
      iterations.corrupt > 0
        ? `${iterations.corrupt} corrupt line(s) skipped`
        : null,
  });
  const outcomes = await readOutcomeObservations(
    path.join(signalsRoot, "outcomes.jsonl"),
  );
  sources.push({
    id: "signals-outcomes",
    path: outcomes.path,
    status: existsSync(outcomes.path) ? "ok" : "missing",
    records: outcomes.outcomes.length,
    detail:
      outcomes.corrupt > 0
        ? `${outcomes.corrupt} corrupt line(s) skipped`
        : null,
  });

  const reactionsPath =
    options.reactionsPath ?? path.join(signalsRoot, "reactions.jsonl");
  const reactions = await collectReactionSamples(reactionsPath);
  sources.push(reactions.source);

  const supervisor = await collectSupervisor(supervisorStatePath);
  sources.push(supervisor.source);

  const tthw = await collectTthw(
    options.tthwPath ?? path.join(home, "cold-start-tthw.json"),
  );
  sources.push(tthw.source);

  const coldStart = collectColdStart(
    path.join(repoRoot, "templates", "cold-start"),
    tthw.tthwMinutes,
  );
  sources.push(coldStart.source);

  const signalChanges = iterations.signals.map(signalToChange);
  const changes = new Map<string, CodeChangeEvidence>();
  for (const change of store.codeChanges) {
    changes.set(changeKey(change), change);
  }
  for (const change of signalChanges) {
    const key = changeKey(change);
    if (!changes.has(key)) {
      changes.set(key, change);
    }
  }

  const interventions = dedupeInterventions([
    ...store.interventions,
    ...kitdInterventions,
  ]);

  const bundle: EvidenceBundle = {
    window,
    sources,
    informationEvents: store.informationEvents,
    triggerRuns: store.triggerRuns,
    manualTasks: store.manualTasks,
    reactionSamples: reactions.samples,
    reactionSignals: reactions.signals,
    manufactureProposals: manufacture.proposals,
    codeChanges: [...changes.values()].sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.iterationId.localeCompare(right.iterationId) ||
        left.taskId.localeCompare(right.taskId),
    ),
    runs: store.runs,
    interventions,
    forbiddenBlocks: store.forbiddenBlocks,
    recoveryDrills: [...store.recoveryDrills, ...recovery.drills].sort(
      (left, right) =>
        left.executedAt.localeCompare(right.executedAt) ||
        left.id.localeCompare(right.id),
    ),
    evolutionPromotions: store.evolutionPromotions,
    concurrencyEvidence: store.concurrencyEvidence,
    factoryEvidence: store.factoryEvidence,
    workshopEvidence: store.workshopEvidence,
    outcomeObservations: outcomes.outcomes.map((outcome) => ({
      at: outcome.at,
      source: outcome.source,
      score: outcome.score,
      pass: outcome.pass,
    })),
    installedComponents: components.components,
    installedSources: installedSources.entries,
    decisionRefs: store.decisionRefs,
    lkgRefs: store.lkgRefs,
    openIncidents: store.openIncidents,
    supervisor: supervisor.state,
    coldStart: coldStart.evidence,
  };
  return bundle;
}

async function collectStore(
  dbPath: string,
  start: string,
  end: string,
): Promise<StoreEvidence & { source: EvidenceSourceStatus }> {
  const empty: StoreEvidence = {
    informationEvents: [],
    triggerRuns: [],
    manualTasks: [],
    codeChanges: [],
    runs: [],
    interventions: [],
    decisionRefs: [],
    lkgRefs: [],
    openIncidents: [],
    forbiddenBlocks: [],
    recoveryDrills: [],
    evolutionPromotions: [],
    concurrencyEvidence: [],
    factoryEvidence: [],
    workshopEvidence: [],
  };
  if (!existsSync(dbPath)) {
    return {
      ...empty,
      source: {
        id: "store-db",
        path: dbPath,
        status: "missing",
        records: 0,
        detail: "SQLite store not found; store-backed gates are GAPs",
      },
    };
  }

  const db = createDb({
    ...loadStoreConfig(process.env),
    driver: "sqlite",
    localDbPath: dbPath,
  });
  const failures: string[] = [];
  let records = 0;
  const run = async <T>(
    label: string,
    query: () => Promise<unknown[]>,
  ): Promise<T[]> => {
    try {
      const rows = (await query()) as T[];
      records += rows.length;
      return rows;
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
      return [];
    }
  };

  try {
    const infoRows = await run<InfoRow>(
      "information_events",
      () =>
        db.sql<InfoRow[]>`
        SELECT event_id, source_id, source_kind, created_at
        FROM information_events
        WHERE created_at >= ${start} AND created_at <= ${end}
        ORDER BY created_at, event_id
      `,
    );
    const triggerRows = await run<TriggerRow>(
      "trigger_runs",
      () =>
        db.sql<TriggerRow[]>`
        SELECT trigger_run_id, trigger_id, trigger_kind, job_id, payload_ref,
               status, launched_at
        FROM trigger_runs
        WHERE launched_at >= ${start} AND launched_at <= ${end}
        ORDER BY launched_at, trigger_run_id
      `,
    );
    const changeRows = await run<ChangeRow>(
      "iteration_tasks",
      () =>
        db.sql<ChangeRow[]>`
        SELECT r.iteration_id, r.origin_kind, r.trigger_run_id, r.status AS run_status,
               t.task_id, t.risk, t.status AS task_status, t.apply_status,
               t.commit_sha, t.started_at, t.result_artifact_id
        FROM iteration_tasks t
        JOIN iteration_runs r ON r.iteration_id = t.iteration_id
        WHERE t.started_at >= ${start} AND t.started_at <= ${end}
        ORDER BY t.started_at, r.iteration_id, t.task_id
      `,
    );
    const runRows = await run<RunRow>(
      "runs",
      () =>
        db.sql<RunRow[]>`
        SELECT r.run_id, r.trigger_run_id, r.status, r.created_at,
               a.artifact_id
        FROM runs r
        LEFT JOIN manifests m ON m.run_id = r.run_id
        LEFT JOIN artifacts a ON a.manifest_id = m.manifest_id
        WHERE r.created_at >= ${start} AND r.created_at <= ${end}
        ORDER BY r.created_at, r.run_id, a.artifact_id
      `,
    );
    const manualRunRows = await run<ManualRunRow>(
      "iteration_runs(manual)",
      () =>
        db.sql<ManualRunRow[]>`
        SELECT iteration_id, started_at
        FROM iteration_runs
        WHERE origin_kind = 'manual'
          AND started_at >= ${start} AND started_at <= ${end}
        ORDER BY started_at, iteration_id
      `,
    );
    const approvalRows = await run<ApprovalRow>(
      "approvals",
      () =>
        db.sql<ApprovalRow[]>`
        SELECT approval_id, kind, status, decision_by, decision_at,
               decision_reason, risk_class
        FROM approvals
        WHERE decision_at IS NOT NULL
          AND decision_at >= ${start} AND decision_at <= ${end}
        ORDER BY decision_at, approval_id
      `,
    );
    const killRows = await run<KillRow>(
      "kill_switches",
      () =>
        db.sql<KillRow[]>`
        SELECT switch_id, scope, target, activated_by, reason, activated_at
        FROM kill_switches
        WHERE activated_at >= ${start} AND activated_at <= ${end}
        ORDER BY activated_at, switch_id
      `,
    );
    const auditRows = await run<ProfileAuditRow>(
      "interest_profile_audits",
      () =>
        db.sql<ProfileAuditRow[]>`
        SELECT audit_id, actor, rationale, occurred_at
        FROM interest_profile_audits
        WHERE occurred_at >= ${start} AND occurred_at <= ${end}
        ORDER BY occurred_at, audit_id
      `,
    );
    const activityRows = await run<ActivityRow>(
      "activity_events",
      () =>
        db.sql<ActivityRow[]>`
        SELECT event_id, agent_id, kind, status, summary, created_at
        FROM activity_events
        WHERE created_at >= ${start} AND created_at <= ${end}
        ORDER BY created_at, event_id
      `,
    );
    const opRows = await run<OpLogRow>(
      "op_log",
      () =>
        db.sql<OpLogRow[]>`
        SELECT op_id, entity_kind, entity_id, op, actor, origin, created_at
        FROM op_log
        WHERE created_at >= ${start} AND created_at <= ${end}
        ORDER BY created_at, seq
      `,
    );
    const drillRows = await run<DrillRow>(
      "recovery_drills",
      () =>
        db.sql<DrillRow[]>`
        SELECT drill_id, executed_at, script, measured_rto_minutes, integrity_pass, outcome
        FROM recovery_drills
        WHERE executed_at >= ${start} AND executed_at <= ${end}
        ORDER BY executed_at, drill_id
      `,
    );
    const lkgRows = await run<LkgRow>(
      "last_known_good",
      () =>
        db.sql<LkgRow[]>`
        SELECT lkg_id, verified_at
        FROM last_known_good
        ORDER BY verified_at DESC, lkg_id DESC
        LIMIT 5
      `,
    );
    const incidentRows = await run<IncidentRow>(
      "incidents(open)",
      () =>
        db.sql<IncidentRow[]>`
        SELECT incident_id
        FROM incidents
        WHERE status IN ('open', 'mitigated')
        ORDER BY incident_id
      `,
    );

    const interventions: InterventionEvidence[] = [
      ...triggerRows
        .filter((row) => row.trigger_kind === "manual")
        .map((row) => ({
          id: `manual-trigger:${row.trigger_run_id}`,
          at: iso(row.launched_at),
          actor: "unattributed",
          kind: `trigger:${row.trigger_id}`,
          category: "routine" as const,
          reason: null,
          risk: null,
        })),
      ...manualRunRows.map((row) => ({
        id: `manual-iteration:${row.iteration_id}`,
        at: iso(row.started_at),
        actor: "unattributed",
        kind: "iteration",
        category: "routine" as const,
        reason: null,
        risk: null,
      })),
      ...killRows.map((row) => ({
        id: `kill-switch:${row.switch_id}`,
        at: iso(row.activated_at),
        actor: stringOr(row.activated_by, "unattributed"),
        kind: `kill-switch:${row.scope}${row.target ? `/${row.target}` : ""}`,
        category: "routine" as const,
        reason: stringOrNull(row.reason),
        risk: null,
      })),
      ...approvalRows.map((row) => ({
        id: `approval:${row.approval_id}`,
        at: iso(row.decision_at),
        actor: stringOr(row.decision_by, "unattributed"),
        kind: `approval:${row.kind}`,
        category: "high-risk-approval" as const,
        reason: stringOrNull(row.decision_reason),
        risk: riskClassOrNull(row.risk_class),
      })),
      ...auditRows
        .filter((row) => stringOr(row.actor, "") !== "ai")
        .map((row) => ({
          id: `interest-profile:${row.audit_id}`,
          at: iso(row.occurred_at),
          actor: stringOr(row.actor, "unattributed"),
          kind: "interest-profile-edit",
          category: "routine" as const,
          reason: stringOrNull(row.rationale),
          risk: null,
        })),
      ...activityRows.flatMap(activityIntervention),
    ];

    const decisionRefs = [
      ...approvalRows.map((row) => `approval:${row.approval_id}`),
      ...activityRows
        .filter((row) => /decision|approv/i.test(row.kind))
        .map((row) => `activity:${String(row.event_id)}`),
    ];

    const forbiddenBlocks = activityRows
      .filter((row) => /forbidden/i.test(`${row.kind} ${row.summary ?? ""}`))
      .map((row) => ({
        id: `activity:${String(row.event_id)}`,
        at: iso(row.created_at),
        detail: stringOr(row.summary, row.kind),
      }));

    const codeChanges: CodeChangeEvidence[] = changeRows.map((row) => ({
      iterationId: String(row.iteration_id),
      taskId: String(row.task_id),
      risk: stringOr(row.risk, "unknown"),
      status: stringOr(row.task_status ?? row.run_status, "unknown"),
      applyStatus: stringOrNull(row.apply_status),
      commitSha: stringOrNull(row.commit_sha),
      originKind: stringOrNull(row.origin_kind),
      triggerRunId: stringOrNull(row.trigger_run_id),
      startedAt: iso(row.started_at),
      resultArtifactId: stringOrNull(row.result_artifact_id),
      source: "store" as const,
    }));

    const manualTasks = [
      ...triggerRows
        .filter((row) => row.trigger_kind === "manual")
        .map((row) => ({
          id: `trigger-run:${row.trigger_run_id}`,
          at: iso(row.launched_at),
          kind: "trigger",
        })),
      ...manualRunRows.map((row) => ({
        id: `iteration:${row.iteration_id}`,
        at: iso(row.started_at),
        kind: "iteration",
      })),
    ];

    const runsById = new Map<string, EvidenceBundle["runs"][number]>();
    for (const row of runRows) {
      const runId = String(row.run_id);
      const existing = runsById.get(runId);
      const artifactId = stringOrNull(row.artifact_id);
      if (existing) {
        if (artifactId && !existing.artifactIds.includes(artifactId)) {
          existing.artifactIds.push(artifactId);
        }
        continue;
      }
      runsById.set(runId, {
        runId,
        triggerRunId: stringOrNull(row.trigger_run_id),
        status: String(row.status),
        artifactIds: artifactId ? [artifactId] : [],
        createdAt: iso(row.created_at),
      });
    }
    const runs = [...runsById.values()]
      .map((run) => ({
        ...run,
        artifactIds: [...run.artifactIds].sort(),
      }))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.runId.localeCompare(right.runId),
      );

    return {
      informationEvents: infoRows.map((row) => ({
        eventId: String(row.event_id),
        sourceId: String(row.source_id),
        sourceKind: stringOr(row.source_kind, "unknown"),
        createdAt: iso(row.created_at),
      })),
      triggerRuns: triggerRows.map((row) => ({
        triggerRunId: String(row.trigger_run_id),
        triggerId: String(row.trigger_id),
        kind: String(row.trigger_kind),
        jobId: stringOrNull(row.job_id),
        payloadRef: stringOrNull(row.payload_ref),
        status: String(row.status),
        launchedAt: iso(row.launched_at),
      })),
      manualTasks,
      codeChanges,
      runs,
      interventions,
      decisionRefs,
      lkgRefs: lkgRows.map(
        (row) => `${String(row.lkg_id)}@${iso(row.verified_at)}`,
      ),
      openIncidents: incidentRows.map((row) => String(row.incident_id)),
      forbiddenBlocks,
      recoveryDrills: drillRows.map((row) => ({
        id: String(row.drill_id),
        executedAt: iso(row.executed_at),
        outcome: String(row.outcome),
        measuredRtoMinutes: numberOrNull(row.measured_rto_minutes),
        integrityPass: Boolean(row.integrity_pass),
        script: stringOr(row.script, "unknown"),
      })),
      evolutionPromotions: activityRows
        .filter((row) => /evolution|promot|canary|rollback/i.test(row.kind))
        .map((row) => ({
          id: `activity:${String(row.event_id)}`,
          at: iso(row.created_at),
          action: String(row.kind),
          status: stringOrNull(row.status),
          detail: stringOr(row.summary, ""),
        })),
      // S9 reads both the activity stream (run lease claims, emitted by the
      // local runner) and the op log (store lock acquisitions/contention,
      // emitted by withStoreLock). Neither source is synthesized: no rows
      // means no concurrency evidence and the gate stays a GAP.
      concurrencyEvidence: [
        ...activityRows
          .filter((row) => CONCURRENCY_KIND.test(row.kind))
          .map(activityEvidence),
        ...opRows
          .filter((row) =>
            CONCURRENCY_KIND.test(`${row.entity_kind} ${row.op}`),
          )
          .map(opEvidence),
      ].sort(
        (left, right) =>
          left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
      ),
      factoryEvidence: activityRows
        .filter((row) => /factory/i.test(row.kind))
        .map(activityEvidence),
      workshopEvidence: activityRows
        .filter((row) => /workshop|component|dag/i.test(row.kind))
        .map(activityEvidence),
      source: {
        id: "store-db",
        path: dbPath,
        status: failures.length === 0 ? "ok" : "unreadable",
        records,
        detail: failures.length > 0 ? failures.join("; ") : null,
      },
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function collectRecoveryReports(
  auditDir: string,
  start: string,
  end: string,
): Promise<{ drills: RecoveryDrillEvidence[]; source: EvidenceSourceStatus }> {
  if (!existsSync(auditDir)) {
    return {
      drills: [],
      source: {
        id: "recovery-reports",
        path: auditDir,
        status: "missing",
        records: 0,
        detail: "audit directory not found",
      },
    };
  }
  const drills: RecoveryDrillEvidence[] = [];
  let corrupt = 0;
  try {
    const entries = await readdir(auditDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^(?:recovery|rollback)-drill-.*\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const file = path.join(auditDir, entry.name);
      try {
        const parsed = JSON.parse(
          await readFile(file, "utf8"),
        ) as RecoveryReport;
        const executedAt =
          isoOrNull(parsed.finishedAt) ?? stampToIso(entry.name);
        if (!executedAt || executedAt < start || executedAt > end) {
          continue;
        }
        const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
        const seconds = numberOrNull(parsed.recoverySeconds);
        drills.push({
          id: entry.name,
          executedAt,
          outcome:
            parsed.outcome === "passed"
              ? "pass"
              : parsed.outcome === "failed"
                ? "fail"
                : stringOr(parsed.outcome, "unknown"),
          measuredRtoMinutes: seconds === null ? null : Math.ceil(seconds / 60),
          integrityPass:
            checks.length > 0 && checks.every((check) => check.pass === true),
          // Drill reports name their own script; older PS1 reports omit it.
          script: stringOr(
            parsed.script,
            `scripts/recovery-drill.ps1:${stringOr(parsed.mode, "unknown")}`,
          ),
        });
      } catch {
        corrupt += 1;
      }
    }
    return {
      drills: drills.sort(
        (left, right) =>
          left.executedAt.localeCompare(right.executedAt) ||
          left.id.localeCompare(right.id),
      ),
      source: {
        id: "recovery-reports",
        path: auditDir,
        status: "ok",
        records: drills.length,
        detail: corrupt > 0 ? `${corrupt} unreadable report(s) skipped` : null,
      },
    };
  } catch (error) {
    return {
      drills: [],
      source: {
        id: "recovery-reports",
        path: auditDir,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

async function collectManufacture(packsRoot: string): Promise<{
  proposals: ManufactureProposalEvidence[];
  source: EvidenceSourceStatus;
}> {
  if (!existsSync(packsRoot)) {
    return {
      proposals: [],
      source: {
        id: "manufacture-proposals",
        path: packsRoot,
        status: "missing",
        records: 0,
        detail: "packs directory not found",
      },
    };
  }
  const proposals: ManufactureProposalEvidence[] = [];
  let corrupt = 0;
  try {
    const packs = await readdir(packsRoot, { withFileTypes: true });
    for (const pack of packs) {
      if (!pack.isDirectory()) {
        continue;
      }
      const dir = path.join(packsRoot, pack.name, ".manufacture", "proposals");
      if (!existsSync(dir)) {
        continue;
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          const raw = JSON.parse(
            await readFile(path.join(dir, entry.name), "utf8"),
          ) as Record<string, unknown>;
          const proposal = parseProposal(raw, pack.name);
          if (proposal) {
            proposals.push(proposal);
          } else {
            corrupt += 1;
          }
        } catch {
          corrupt += 1;
        }
      }
    }
    return {
      proposals: proposals.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
      source: {
        id: "manufacture-proposals",
        path: packsRoot,
        status: "ok",
        records: proposals.length,
        detail:
          corrupt > 0 ? `${corrupt} unreadable proposal(s) skipped` : null,
      },
    };
  } catch (error) {
    return {
      proposals: [],
      source: {
        id: "manufacture-proposals",
        path: packsRoot,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

function parseProposal(
  raw: Record<string, unknown>,
  pack: string,
): ManufactureProposalEvidence | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  const status = typeof raw.status === "string" ? raw.status : "";
  const createdAt = isoOrNull(raw.createdAt);
  if (!id || !kind || !status || !createdAt) {
    return null;
  }
  const acceptance =
    raw.acceptance && typeof raw.acceptance === "object"
      ? (raw.acceptance as Record<string, unknown>)
      : null;
  const files =
    acceptance && Array.isArray(acceptance.files)
      ? acceptance.files.filter(
          (file): file is string => typeof file === "string",
        )
      : [];
  const provenance =
    acceptance?.provenance && typeof acceptance.provenance === "object"
      ? (acceptance.provenance as Record<string, unknown>)
      : null;
  const source =
    provenance?.source && typeof provenance.source === "object"
      ? (provenance.source as Record<string, unknown>)
      : null;
  return {
    id,
    kind,
    status,
    model: typeof raw.model === "string" ? raw.model : "unknown",
    createdAt,
    acceptedAt: acceptance ? isoOrNull(acceptance.at) : null,
    assetId:
      typeof raw.assetId === "string" && raw.assetId
        ? raw.assetId
        : `${pack}:${id}`,
    files,
    provenanceSha256:
      source && typeof source.sha256 === "string" ? source.sha256 : null,
  };
}

async function collectComponents(packsRoot: string): Promise<{
  components: InstalledComponentEvidence[];
  source: EvidenceSourceStatus;
}> {
  const components: InstalledComponentEvidence[] = [];
  if (!existsSync(packsRoot)) {
    return {
      components,
      source: {
        id: "components-lock",
        path: packsRoot,
        status: "missing",
        records: 0,
        detail: "packs directory not found",
      },
    };
  }
  let corrupt = 0;
  try {
    for (const entry of await readdir(packsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const file = path.join(packsRoot, entry.name, "components.lock.json");
      if (!existsSync(file)) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as {
          components?: Array<{ kind?: unknown; id?: unknown }>;
        };
        for (const component of parsed.components ?? []) {
          if (
            typeof component.kind === "string" &&
            typeof component.id === "string"
          ) {
            components.push({
              pack: entry.name,
              kind: component.kind,
              id: component.id,
            });
          }
        }
      } catch {
        corrupt += 1;
      }
    }
    components.sort(
      (left, right) =>
        left.pack.localeCompare(right.pack) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );
    return {
      components,
      source: {
        id: "components-lock",
        path: packsRoot,
        status: "ok",
        records: components.length,
        detail:
          corrupt > 0 ? `${corrupt} unreadable lockfile(s) skipped` : null,
      },
    };
  } catch (error) {
    return {
      components,
      source: {
        id: "components-lock",
        path: packsRoot,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

async function collectInstalledSources(sourcesRoot: string): Promise<{
  entries: InstalledSourceEvidence[];
  source: EvidenceSourceStatus;
}> {
  if (!existsSync(sourcesRoot)) {
    return {
      entries: [],
      source: {
        id: "installed-sources",
        path: sourcesRoot,
        status: "missing",
        records: 0,
        detail: "sources root not found",
      },
    };
  }
  const entries: InstalledSourceEvidence[] = [];
  let corrupt = 0;
  try {
    for (const entry of await readdir(sourcesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) {
        continue;
      }
      try {
        const parsed = JSON.parse(
          await readFile(path.join(sourcesRoot, entry.name), "utf8"),
        ) as { name?: unknown; id?: unknown; installedAt?: unknown };
        const sourceId =
          typeof parsed.name === "string"
            ? parsed.name
            : typeof parsed.id === "string"
              ? parsed.id
              : entry.name.replace(/\.meta\.json$/i, "");
        entries.push({
          sourceId,
          installedAt: isoOrNull(parsed.installedAt),
        });
      } catch {
        corrupt += 1;
      }
    }
    entries.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    return {
      entries,
      source: {
        id: "installed-sources",
        path: sourcesRoot,
        status: "ok",
        records: entries.length,
        detail:
          corrupt > 0 ? `${corrupt} unreadable meta file(s) skipped` : null,
      },
    };
  } catch (error) {
    return {
      entries,
      source: {
        id: "installed-sources",
        path: sourcesRoot,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

/**
 * One reactions file, two record kinds: automatic `reaction.outcome` signals
 * written by the reaction dispatcher (#259) and human usefulness samples
 * (docs/gate-report.md#reaction-sampling). `kind` distinguishes them; the
 * automatic signals are the system-produced evidence G2 now reads, while
 * `useful`/`costCny` stay a human judgement and are never synthesized.
 */
async function collectReactionSamples(file: string): Promise<{
  samples: ReactionSampleEvidence[];
  signals: ReactionSignalEvidence[];
  source: EvidenceSourceStatus;
}> {
  const read = await readJsonl(file);
  const samples: ReactionSampleEvidence[] = [];
  const signals: ReactionSignalEvidence[] = [];
  const seenSamples = new Set<string>();
  const seenSignals = new Set<string>();
  let corrupt = read.corrupt;
  for (const record of read.records) {
    if (isReactionSignalRecord(record)) {
      // A crashed append can leave the same signal twice; collapse by id.
      if (seenSignals.has(record.signalId)) {
        continue;
      }
      seenSignals.add(record.signalId);
      signals.push({
        at: record.at,
        eventId: record.eventId,
        ruleId: record.ruleId,
        triggerRunId: record.triggerRunId,
        jobId: record.jobId,
        outcome: record.outcome,
        dedupeKey: record.dedupeKey,
      });
      continue;
    }
    const sample = parseReaction(record);
    if (!sample) {
      corrupt += 1;
      continue;
    }
    const key = `${sample.at}|${sample.eventId}|${sample.triggerRunId ?? ""}`;
    if (seenSamples.has(key)) {
      corrupt += 1;
      continue;
    }
    seenSamples.add(key);
    samples.push(sample);
  }
  samples.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.eventId.localeCompare(right.eventId) ||
      (left.triggerRunId ?? "").localeCompare(right.triggerRunId ?? ""),
  );
  signals.sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.eventId.localeCompare(right.eventId) ||
      left.ruleId.localeCompare(right.ruleId),
  );
  const detail = sourceDetail({ ...read, corrupt });
  const counts = `${signals.length} automatic signal(s), ${samples.length} sample(s)`;
  return {
    samples,
    signals,
    source: {
      id: "reaction-samples",
      path: file,
      status: read.status,
      records: samples.length + signals.length,
      detail: detail ? `${counts}; ${detail}` : counts,
    },
  };
}

function parseReaction(value: unknown): ReactionSampleEvidence | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const at = isoOrNull(raw.at);
  const eventId = typeof raw.eventId === "string" ? raw.eventId : "";
  if (!at || !eventId || typeof raw.useful !== "boolean") {
    return null;
  }
  const triggerRunId =
    typeof raw.triggerRunId === "string" && raw.triggerRunId
      ? raw.triggerRunId
      : null;
  const costCny =
    typeof raw.costCny === "number" && Number.isFinite(raw.costCny)
      ? raw.costCny
      : null;
  return { at, eventId, triggerRunId, useful: raw.useful, costCny };
}

async function collectSupervisor(
  file: string,
): Promise<{ state: SupervisorEvidence | null; source: EvidenceSourceStatus }> {
  if (!existsSync(file)) {
    return {
      state: null,
      source: {
        id: "supervisor-state",
        path: file,
        status: "missing",
        records: 0,
        detail: "supervisor state not found",
      },
    };
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      children?: Array<{ name?: unknown }>;
    };
    const children = (parsed.children ?? [])
      .map((child) => (typeof child.name === "string" ? child.name : ""))
      .filter(Boolean)
      .sort();
    return {
      state: { present: true, children },
      source: {
        id: "supervisor-state",
        path: file,
        status: "ok",
        records: children.length,
        detail: null,
      },
    };
  } catch (error) {
    return {
      state: null,
      source: {
        id: "supervisor-state",
        path: file,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

function collectColdStart(
  root: string,
  tthwMinutes: number | null,
): {
  evidence: ColdStartEvidence | null;
  source: EvidenceSourceStatus;
} {
  try {
    const report = checkColdStartPackage(root);
    return {
      evidence: {
        packageOk: report.ok,
        missing: report.missing,
        tthwMinutes,
      },
      source: {
        id: "cold-start-package",
        path: root,
        status: "ok",
        records: report.checks.length,
        detail: report.ok
          ? "package checks pass"
          : `${report.missing.length} package item(s) missing`,
      },
    };
  } catch (error) {
    return {
      evidence: null,
      source: {
        id: "cold-start-package",
        path: root,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

/**
 * Reads the zero-config TTHW ledger written by the bootstrap flow (plan 91 §5,
 * 98 §5.2 S12). The collector never derives a duration: without a persisted
 * start marker and ready timestamp it returns null and the gate stays a GAP.
 *
 * This is a one-time install measurement, so it is not clipped to the report
 * window; the ready timestamp is surfaced in the source detail for audit.
 */
async function collectTthw(file: string): Promise<TthwCollection> {
  if (!existsSync(file)) {
    return {
      tthwMinutes: null,
      source: {
        id: "zero-config-tthw",
        path: file,
        status: "missing",
        records: 0,
        detail: "no zero-config measurement recorded",
      },
    };
  }
  try {
    const text = await readFile(file, "utf8");
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.apiVersion !== "agentteam/v1" || raw.kind !== "ZeroConfigTthw") {
      return {
        tthwMinutes: null,
        source: {
          id: "zero-config-tthw",
          path: file,
          status: "unreadable",
          records: 0,
          detail: "not a ZeroConfigTthw ledger",
        },
      };
    }
    const startedAt = isoOrNull(raw.startedAt);
    const readyAt = isoOrNull(raw.readyAt);
    const minutes = numberOrNull(raw.tthwMinutes);
    const measure = stringOrNull(raw.measure);
    let detail: string | null = null;
    if (!startedAt) {
      detail = "ledger has no start marker; TTHW not measured";
    } else if (!readyAt) {
      detail = "ledger has no first-value milestone";
    } else if (minutes === null) {
      detail = "ledger has no numeric TTHW";
    } else {
      detail = `measure=${measure ?? "unknown"} readyAt=${readyAt}`;
    }
    const measured = startedAt && readyAt && minutes !== null ? minutes : null;
    return {
      tthwMinutes: measured,
      source: {
        id: "zero-config-tthw",
        path: file,
        status: "ok",
        records: measured === null ? 0 : 1,
        detail,
      },
    };
  } catch (error) {
    return {
      tthwMinutes: null,
      source: {
        id: "zero-config-tthw",
        path: file,
        status: "unreadable",
        records: 0,
        detail: errorMessage(error),
      },
    };
  }
}

async function readJsonl(file: string): Promise<JsonlRead> {
  if (!existsSync(file)) {
    return { status: "missing", records: [], corrupt: 0, error: null };
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      status: "unreadable",
      records: [],
      corrupt: 0,
      error: errorMessage(error),
    };
  }
  const records: unknown[] = [];
  let corrupt = 0;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      corrupt += 1;
    }
  }
  return { status: "ok", records, corrupt, error: null };
}

function kitdIntervention(
  record: KitdRecord,
  index: number,
  start: string,
  end: string,
): InterventionEvidence[] {
  const at = isoOrNull(record.at);
  const action = stringOr(record.action, "");
  if (!at || at < start || at > end) {
    return [];
  }
  if (!/rollback|snapshot|lkg|drill|kill|switch/i.test(action)) {
    return [];
  }
  if (/^drill\./i.test(action)) {
    return [];
  }
  return [
    {
      id: `kitd:${index}:${action}`,
      at,
      actor: "operator:kitd",
      kind: `kitd:${action}`,
      category: "recovery",
      reason: stringOrNull(record.detail),
      risk: null,
    },
  ];
}

/**
 * Only explicit operator actions become interventions. Automated blocks such
 * as `ops.side_effect.blocked` are not human confirmations and must not be
 * counted toward the observer-boundary budget.
 */
function activityIntervention(row: ActivityRow): InterventionEvidence[] {
  const kind = String(row.kind);
  const releaseBudget =
    /^ops\.(autonomy\.(enabled|rolled_back)|budget\.(confirmed|approved))$/.test(
      kind,
    );
  const killSwitch = /^kill(?:[.-]|$)/i.test(kind);
  if (!releaseBudget && !killSwitch) {
    return [];
  }
  return [
    {
      id: `activity:${String(row.event_id)}`,
      at: iso(row.created_at),
      actor: stringOr(row.agent_id, "unattributed"),
      kind,
      category: killSwitch ? "routine" : "release-budget",
      reason: stringOrNull(row.summary),
      risk: null,
    },
  ];
}

function signalToChange(signal: {
  at: string;
  iterationId: string;
  taskId: string;
  risk: string;
  verified: boolean;
  applied: boolean;
}): CodeChangeEvidence {
  return {
    iterationId: signal.iterationId,
    taskId: signal.taskId,
    risk: signal.risk,
    status: signal.verified ? "succeeded" : "failed",
    applyStatus: signal.applied ? "applied" : null,
    commitSha: null,
    originKind: "evolution-signal",
    triggerRunId: null,
    startedAt: signal.at,
    resultArtifactId: null,
    source: "signals",
  };
}

function dedupeInterventions(
  items: InterventionEvidence[],
): InterventionEvidence[] {
  const seen = new Set<string>();
  const result: InterventionEvidence[] = [];
  for (const item of items) {
    const key = `${item.at}|${item.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result.sort(
    (left, right) =>
      left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
}

function changeKey(change: CodeChangeEvidence): string {
  return `${change.iterationId}:${change.taskId}`;
}

function activityEvidence(row: ActivityRow): ActivityEvidence {
  return {
    id: `activity:${String(row.event_id)}`,
    at: iso(row.created_at),
    kind: String(row.kind),
    status: stringOrNull(row.status),
  };
}

function opEvidence(row: OpLogRow): ActivityEvidence {
  return {
    id: `op:${row.op_id}`,
    at: iso(row.created_at),
    kind: String(row.op),
    status: stringOrNull(row.origin),
  };
}

function isKitdRecord(value: unknown): value is KitdRecord {
  return typeof value === "object" && value !== null;
}

function sourceDetail(read: JsonlRead): string | null {
  const parts: string[] = [];
  if (read.error) {
    parts.push(read.error);
  }
  if (read.corrupt > 0) {
    parts.push(`${read.corrupt} corrupt line(s) skipped`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function iso(value: unknown): string {
  return isoOrNull(value) ?? "";
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function stampToIso(fileName: string): string | null {
  const match = /^(?:recovery|rollback)-drill-(\d{8})-(\d{6})\.json$/i.exec(
    fileName,
  );
  if (!match) {
    return null;
  }
  const [, date, time] = match;
  if (!date || !time) {
    return null;
  }
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Approval risk class read from the store. Missing/unknown values stay null so
 * the observer gate reports them as unlabelled evidence instead of guessing.
 */
function riskClassOrNull(value: unknown): "low" | "medium" | "high" | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultHome(): string {
  return process.env.KIT_HOME
    ? path.resolve(process.env.KIT_HOME)
    : path.join(os.homedir(), ".agent-team-kit");
}

interface InfoRow {
  event_id: string;
  source_id: string;
  source_kind: string;
  created_at: string;
}
interface TriggerRow {
  trigger_run_id: string;
  trigger_id: string;
  trigger_kind: string;
  job_id: string | null;
  payload_ref: string | null;
  status: string;
  launched_at: string;
}
interface ChangeRow {
  iteration_id: string;
  origin_kind: string | null;
  trigger_run_id: string | null;
  run_status: string | null;
  task_id: string;
  risk: string | null;
  task_status: string | null;
  apply_status: string | null;
  commit_sha: string | null;
  started_at: string;
  result_artifact_id: string | null;
}
interface RunRow {
  run_id: string;
  trigger_run_id: string | null;
  status: string;
  created_at: string;
  artifact_id: string | null;
}
interface ManualRunRow {
  iteration_id: string;
  started_at: string;
}
interface ApprovalRow {
  approval_id: string;
  kind: string;
  status: string;
  decision_by: string | null;
  decision_at: string;
  decision_reason: string | null;
  /** Null on rows written before risk classes were recorded. */
  risk_class: string | null;
}
interface KillRow {
  switch_id: string;
  scope: string;
  target: string;
  activated_by: string;
  reason: string;
  activated_at: string;
}
interface ProfileAuditRow {
  audit_id: string;
  actor: string;
  rationale: string;
  occurred_at: string;
}
interface ActivityRow {
  event_id: number | string;
  agent_id: string | null;
  kind: string;
  status: string | null;
  summary: string | null;
  created_at: string;
}
interface TthwCollection {
  tthwMinutes: number | null;
  source: EvidenceSourceStatus;
}
interface OpLogRow {
  op_id: string;
  entity_kind: string;
  entity_id: string;
  op: string;
  actor: string;
  origin: string;
  created_at: string;
}
interface DrillRow {
  drill_id: string;
  executed_at: string;
  script: string;
  measured_rto_minutes: number | string | null;
  integrity_pass: boolean | number;
  outcome: string;
}
interface LkgRow {
  lkg_id: string;
  verified_at: string;
}
interface IncidentRow {
  incident_id: string;
}
