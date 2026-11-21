/**
 * Pure 1.0 gate report builder (98 §5.1/§5.2, 85 §5.2, issue #135).
 *
 * The model never reads the filesystem and never invents values: every gate
 * is either backed by records in {@link EvidenceBundle} or reported as an
 * explicit GAP with the missing evidence named. A report can therefore be
 * replayed from a checked-in evidence JSON file and compared byte-for-byte.
 */
export const DEFAULT_WINDOW_DAYS = 7;
export const GATE_RTO_TARGET_MINUTES = 10;
export const GATE_MIN_USEFUL_RATE = 0.8;
export const GATE_MAX_NOISE_COST_RATIO = 0.2;

const DAY_MS = 86_400_000;

export const GATE_IDS = [
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
] as const;

export type GateId = (typeof GATE_IDS)[number];

export interface GateWindow {
  /** Inclusive ISO start (UTC midnight of the first day). */
  start: string;
  /** Inclusive ISO end. */
  end: string;
  /** Number of UTC calendar days the window covers. */
  days: number;
}

export interface EvidenceSourceStatus {
  id: string;
  path: string;
  status: "ok" | "missing" | "unreadable";
  records: number;
  detail: string | null;
}

export interface InformationEventEvidence {
  eventId: string;
  sourceId: string;
  sourceKind: string;
  createdAt: string;
}

export interface TriggerRunEvidence {
  triggerRunId: string;
  triggerId: string;
  kind: string;
  jobId: string | null;
  payloadRef: string | null;
  status: string;
  launchedAt: string;
}

export interface ManualTaskEvidence {
  id: string;
  at: string;
  kind: string;
}

export interface ReactionSampleEvidence {
  at: string;
  eventId: string;
  triggerRunId: string | null;
  useful: boolean;
  costCny: number | null;
}

/**
 * Automatic reaction signal written by the reaction dispatcher (#259). It
 * proves a reaction happened and links event → rule → trigger run → job;
 * usefulness remains a human judgement and stays in the sample records.
 */
export interface ReactionSignalEvidence {
  at: string;
  eventId: string;
  ruleId: string;
  triggerRunId: string | null;
  jobId: string | null;
  outcome: string;
  dedupeKey: string;
}

export interface ManufactureProposalEvidence {
  id: string;
  kind: string;
  status: string;
  model: string;
  createdAt: string;
  acceptedAt: string | null;
  assetId: string;
  files: string[];
  provenanceSha256: string | null;
}

export interface RunEvidence {
  runId: string;
  triggerRunId: string | null;
  status: string;
  artifactIds: string[];
  createdAt: string;
}

export interface CodeChangeEvidence {
  iterationId: string;
  taskId: string;
  risk: string;
  status: string;
  applyStatus: string | null;
  commitSha: string | null;
  originKind: string | null;
  triggerRunId: string | null;
  startedAt: string;
  resultArtifactId: string | null;
  source: "store" | "signals";
  /**
   * Approval that cleared this change (85 hard contract 3, 98 §5.2 G4). Either
   * the proposal's decided `approval_ref` or the request-time link read from
   * `approvals.change_id`. Null when no approval was recorded.
   */
  approvalRef: string | null;
  /** Status of the linked approval (`approved`, `queued`, …). */
  approvalStatus: string | null;
  /** Risk class recorded on the approval; null stays unlabelled evidence. */
  approvalRisk: "low" | "medium" | "high" | null;
  approvalBy: string | null;
}

export type InterventionCategory =
  | "routine"
  | "high-risk-approval"
  | "release-budget"
  | "recovery";

export interface InterventionEvidence {
  id: string;
  at: string;
  actor: string;
  kind: string;
  category: InterventionCategory;
  reason: string | null;
  /** Risk class for approvals; null when the audit row does not record one. */
  risk: "low" | "medium" | "high" | null;
}

export interface ForbiddenBlockEvidence {
  id: string;
  at: string;
  detail: string;
}

export interface RecoveryDrillEvidence {
  id: string;
  executedAt: string;
  outcome: string;
  measuredRtoMinutes: number | null;
  integrityPass: boolean;
  script: string;
}

export interface EvolutionPromotionEvidence {
  id: string;
  at: string;
  action: string;
  status: string | null;
  detail: string;
}

export interface ActivityEvidence {
  id: string;
  at: string;
  kind: string;
  status: string | null;
}

export interface OutcomeObservationEvidence {
  at: string;
  source: string;
  score: number;
  pass: boolean;
}

export interface InstalledComponentEvidence {
  pack: string;
  kind: string;
  id: string;
}

export interface InstalledSourceEvidence {
  sourceId: string;
  installedAt: string | null;
}

export interface SupervisorEvidence {
  present: boolean;
  children: string[];
}

export interface ColdStartEvidence {
  packageOk: boolean;
  missing: string[];
  /** Time-to-first-success in minutes; null until an install is measured. */
  tthwMinutes: number | null;
}

export interface EvidenceBundle {
  window: GateWindow;
  sources: EvidenceSourceStatus[];
  informationEvents: InformationEventEvidence[];
  triggerRuns: TriggerRunEvidence[];
  manualTasks: ManualTaskEvidence[];
  reactionSamples: ReactionSampleEvidence[];
  reactionSignals: ReactionSignalEvidence[];
  manufactureProposals: ManufactureProposalEvidence[];
  codeChanges: CodeChangeEvidence[];
  runs: RunEvidence[];
  interventions: InterventionEvidence[];
  forbiddenBlocks: ForbiddenBlockEvidence[];
  recoveryDrills: RecoveryDrillEvidence[];
  evolutionPromotions: EvolutionPromotionEvidence[];
  concurrencyEvidence: ActivityEvidence[];
  factoryEvidence: ActivityEvidence[];
  workshopEvidence: ActivityEvidence[];
  outcomeObservations: OutcomeObservationEvidence[];
  installedComponents: InstalledComponentEvidence[];
  installedSources: InstalledSourceEvidence[];
  decisionRefs: string[];
  lkgRefs: string[];
  openIncidents: string[];
  supervisor: SupervisorEvidence | null;
  coldStart: ColdStartEvidence | null;
}

export interface GateCheck {
  code: string;
  ok: boolean;
  detail: string;
}

export interface GateGap {
  code: string;
  detail: string;
}

export interface GateResult {
  id: GateId;
  title: string;
  requirement: string;
  status: "pass" | "gap";
  checks: GateCheck[];
  evidence: string[];
  gaps: GateGap[];
  metrics: Record<string, number | string | boolean | null>;
}

export interface GateReport {
  apiVersion: "agentteam/v1";
  kind: "OneZeroGateReport";
  reportVersion: 1;
  window: GateWindow;
  generatedAt: string;
  /** True only when every gate has evidence; this is not a 1.0 claim. */
  allGatesSatisfied: boolean;
  /** Always false: this report is evidence, not a version claim. */
  claimedOneZero: false;
  statement: string;
  targets: {
    rtoMinutes: number;
    usefulRate: number;
    noiseCostRatio: number;
  };
  sources: EvidenceSourceStatus[];
  gates: GateResult[];
  gaps: string[];
}

interface GateDraft {
  id: GateId;
  title: string;
  requirement: string;
  checks: GateCheck[];
  evidence: string[];
  gaps: GateGap[];
  metrics: Record<string, number | string | boolean | null>;
}

export function buildWindow(
  now: string,
  days = DEFAULT_WINDOW_DAYS,
): GateWindow {
  const endMs = Date.parse(now);
  if (!Number.isFinite(endMs) || days < 1) {
    throw new Error(`invalid report window: now=${now} days=${days}`);
  }
  const endDate = new Date(endMs);
  const startMs =
    Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate(),
    ) -
    (days - 1) * DAY_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: endDate.toISOString(),
    days,
  };
}

export function buildGateReport(bundle: EvidenceBundle): GateReport {
  const g1 = gateInformationLoop(bundle);
  const g2 = gateReactionQuality(bundle);
  const g3 = gateAssetManufacture(bundle);
  const g4 = gateCodeManufacture(bundle);
  const g5 = gateObserverBoundary(bundle);
  const g6 = gateRecovery(bundle);
  const g7 = gateTraceability(bundle);
  const g8 = gateSupportConditions(
    bundle,
    g6.gaps.length === 0,
    g7.gaps.length === 0,
  );
  const gates = [g1, g2, g3, g4, g5, g6, g7, g8].map(finishGate);
  const allGatesSatisfied = gates.every((gate) => gate.status === "pass");
  const gaps = gates.flatMap((gate) => gate.gaps.map((gap) => gap.code)).sort();
  return {
    apiVersion: "agentteam/v1",
    kind: "OneZeroGateReport",
    reportVersion: 1,
    window: bundle.window,
    generatedAt: bundle.window.end,
    allGatesSatisfied,
    claimedOneZero: false,
    statement: allGatesSatisfied
      ? "All 98 §5.2 gates have evidence in this window; claiming 1.0 still requires operator sign-off and a plan backwrite."
      : "1.0 is not yet achieved: at least one 98 §5.2 main gate has no evidence (see GAP entries).",
    targets: {
      rtoMinutes: GATE_RTO_TARGET_MINUTES,
      usefulRate: GATE_MIN_USEFUL_RATE,
      noiseCostRatio: GATE_MAX_NOISE_COST_RATIO,
    },
    sources: [...bundle.sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    gates,
    gaps,
  };
}

function gateInformationLoop(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G1",
    "信息闭环常驻",
    "连续 7 天由信源自采集驱动运行，无人工建任务；至少一个信源由 AI 自造并采纳。",
  );
  const events = bundle.informationEvents.filter((event) =>
    inside(bundle.window, event.createdAt),
  );
  const days = new Set<string>();
  for (const event of events) {
    const day = utcDay(event.createdAt);
    if (day) {
      days.add(day);
    }
  }
  const informationJobs = informationTriggerRuns(bundle);
  const manual = bundle.manualTasks.filter((task) =>
    inside(bundle.window, task.at),
  );
  const sourceProposals = bundle.manufactureProposals.filter(
    (proposal) =>
      proposal.kind === "source" &&
      proposal.status === "accepted" &&
      inside(bundle.window, proposal.acceptedAt ?? proposal.createdAt),
  );

  check(
    gate,
    "window-seven-days",
    bundle.window.days === 7,
    `window covers ${bundle.window.days} days; 98 §5.2 requires 7`,
  );
  check(
    gate,
    "events-present",
    events.length > 0,
    `${events.length} information event(s) in window`,
  );
  check(
    gate,
    "continuity",
    days.size === 7,
    `${days.size}/7 UTC days carry at least one information event`,
  );
  check(
    gate,
    "information-jobs-present",
    informationJobs.length > 0,
    `${informationJobs.length} information-triggered run(s) in window`,
  );
  check(
    gate,
    "no-manual-tasks",
    manual.length === 0,
    `${manual.length} task(s) created by a human in window`,
  );
  check(
    gate,
    "ai-adopted-source",
    sourceProposals.length >= 1,
    `${sourceProposals.length} accepted AI source proposal(s) in window`,
  );

  gate.evidence.push(
    `store:information_events n=${events.length} days=${days.size}`,
    `store:trigger_runs kind=information n=${informationJobs.length}`,
    `store:iteration/manual n=${manual.length}`,
    `manufacture:source_proposals accepted=${sourceProposals.length}`,
    `sources:installed_sources n=${bundle.installedSources.length}`,
  );
  gate.metrics = {
    informationEvents: events.length,
    daysCovered: days.size,
    informationJobs: informationJobs.length,
    manualTasks: manual.length,
    aiAdoptedSources: sourceProposals.length,
    installedSources: bundle.installedSources.length,
  };
  return gate;
}

function gateReactionQuality(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G2",
    "反应有效",
    "抽样反应 ≥ 80% 被观察者判定为有用；噪声反应成本 ≤ 总反应成本 20%。",
  );
  const jobs = informationTriggerRuns(bundle);
  const jobIds = new Set(jobs.map((job) => job.triggerRunId));
  const signals = bundle.reactionSignals
    .filter((signal) => inside(bundle.window, signal.at))
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.eventId.localeCompare(right.eventId) ||
        left.ruleId.localeCompare(right.ruleId),
    );
  const launchedSignals = signals.filter(
    (signal) => signal.outcome === "fired" || signal.outcome === "existing",
  );
  const unlinkedSignals = launchedSignals.filter(
    (signal) =>
      signal.triggerRunId === null || !jobIds.has(signal.triggerRunId),
  );
  const samples = bundle.reactionSamples
    .filter((sample) => inside(bundle.window, sample.at))
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        left.eventId.localeCompare(right.eventId) ||
        (left.triggerRunId ?? "").localeCompare(right.triggerRunId ?? ""),
    );
  const linked = samples.filter(
    (sample) => sample.triggerRunId !== null && jobIds.has(sample.triggerRunId),
  );
  const useful = samples.filter((sample) => sample.useful).length;
  const usefulRate =
    samples.length > 0 ? round(useful / samples.length, 4) : null;
  const costComplete = samples.every(
    (sample) =>
      typeof sample.costCny === "number" && Number.isFinite(sample.costCny),
  );
  let totalCost = 0;
  let noiseCost = 0;
  if (costComplete) {
    for (const sample of samples) {
      const cost = sample.costCny ?? 0;
      totalCost += cost;
      if (!sample.useful) {
        noiseCost += cost;
      }
    }
  }
  const noiseRate =
    costComplete && totalCost > 0 ? round(noiseCost / totalCost, 4) : null;

  check(
    gate,
    "signals-observed",
    launchedSignals.length > 0,
    `${launchedSignals.length} automatic reaction signal(s) in window`,
  );
  check(
    gate,
    "signals-linked",
    launchedSignals.length > 0 && unlinkedSignals.length === 0,
    `${unlinkedSignals.length}/${launchedSignals.length} launched signal(s) do not resolve to an information trigger run`,
  );
  check(
    gate,
    "samples-present",
    samples.length > 0,
    `${samples.length} reaction sample(s) in window`,
  );
  check(
    gate,
    "samples-linked",
    samples.length > 0 && linked.length === samples.length,
    `${linked.length}/${samples.length} sample(s) link to an information trigger run`,
  );
  check(
    gate,
    "useful-rate",
    usefulRate !== null && usefulRate >= GATE_MIN_USEFUL_RATE,
    usefulRate === null
      ? "useful rate not measured"
      : `${useful}/${samples.length} useful (${usefulRate})`,
  );
  check(
    gate,
    "cost-complete",
    samples.length > 0 && costComplete,
    samples.length === 0
      ? "no reaction sample to cost"
      : costComplete
        ? "every sample records costCny"
        : "at least one sample has no costCny",
  );
  check(
    gate,
    "cost-positive",
    costComplete && totalCost > 0,
    samples.length === 0
      ? "sampled reaction cost not measured"
      : `sampled reaction cost ${costComplete ? round(totalCost, 6) : "unknown"} CNY`,
  );
  check(
    gate,
    "noise-cost-ratio",
    noiseRate !== null && noiseRate <= GATE_MAX_NOISE_COST_RATIO,
    noiseRate === null
      ? "noise cost ratio not measured"
      : `${round(noiseCost, 6)}/${round(totalCost, 6)} CNY (${noiseRate})`,
  );

  gate.evidence.push(
    `signals:reaction_outcomes n=${signals.length} launched=${launchedSignals.length}`,
    `signals:reaction_samples n=${samples.length}`,
    `store:trigger_runs kind=information n=${jobs.length}`,
    "sampling contract: docs/gate-report.md#reaction-sampling",
  );
  gate.metrics = {
    signals: signals.length,
    launchedSignals: launchedSignals.length,
    linkedSignals: launchedSignals.length - unlinkedSignals.length,
    blockedSignals: signals.length - launchedSignals.length,
    samples: samples.length,
    linkedSamples: linked.length,
    usefulRate,
    noiseCostRatio: noiseRate,
    noiseCostCny: costComplete ? round(noiseCost, 6) : null,
    totalCostCny: costComplete ? round(totalCost, 6) : null,
  };
  return gate;
}

function gateAssetManufacture(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G3",
    "资产自制造",
    "系统端到端制造并采纳至少一个新的 agent/workflow/流水线/信源，人工只观察/编辑，无人工写文件。",
  );
  const accepted = bundle.manufactureProposals
    .filter(
      (proposal) =>
        proposal.status === "accepted" &&
        inside(bundle.window, proposal.acceptedAt ?? proposal.createdAt),
    )
    .sort(
      (left, right) =>
        (left.acceptedAt ?? left.createdAt).localeCompare(
          right.acceptedAt ?? right.createdAt,
        ) || left.id.localeCompare(right.id),
    );
  const acceptedKinds = new Set([
    "agent",
    "manager",
    "workflow",
    "pipeline",
    "component",
    "source",
  ]);
  const manufactured = accepted.filter((proposal) =>
    acceptedKinds.has(proposal.kind),
  );
  const live = manufactured.filter((proposal) => proposal.model === "live");
  const systemWritten = manufactured.filter(
    (proposal) =>
      proposal.files.length > 0 && proposal.provenanceSha256 !== null,
  );

  check(
    gate,
    "accepted-asset",
    manufactured.length >= 1,
    `${accepted.length} accepted proposal(s), ${manufactured.length} with a manufacturable kind`,
  );
  check(
    gate,
    "ai-drafted",
    live.length >= 1,
    `${live.length} accepted proposal(s) drafted by the model`,
  );
  check(
    gate,
    "system-written",
    systemWritten.length >= 1,
    `${systemWritten.length} accepted proposal(s) carry written files and provenance sha256`,
  );

  gate.evidence.push(
    ...manufactured.map(
      (proposal) =>
        `manufacture:${proposal.kind}/${proposal.assetId} id=${proposal.id} accepted=${proposal.acceptedAt ?? "unknown"} files=${proposal.files.length}`,
    ),
    `packs:components_lock n=${bundle.installedComponents.length}`,
  );
  gate.metrics = {
    accepted: accepted.length,
    manufactured: manufactured.length,
    aiDrafted: live.length,
    systemWritten: systemWritten.length,
    installedComponents: bundle.installedComponents.length,
  };
  return gate;
}

function gateCodeManufacture(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G4",
    "代码自制造",
    "kit-self-build 完成至少一次低/中风险代码改动并自动合并；高风险仍审批；forbidden = 0。",
  );
  const changes = bundle.codeChanges
    .filter((change) => inside(bundle.window, change.startedAt))
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.iterationId.localeCompare(right.iterationId) ||
        left.taskId.localeCompare(right.taskId),
    );
  const applied = changes.filter(
    (change) => isLowOrMedium(change.risk) && isApplied(change),
  );
  const highRisk = changes.filter((change) => change.risk === "high");
  const highRiskApplied = highRisk.filter(isApplied);
  // G4 only counts an approval link as real evidence when the row was decided
  // and carries the high risk class; a parked or unlabelled approval stays a
  // GAP instead of being read as a high-risk confirmation.
  const highRiskApproved = highRiskApplied.filter(isApprovedHighRiskLink);
  const highRiskUnlinked = highRiskApplied.filter(
    (change) => !isApprovedHighRiskLink(change),
  );
  const forbidden = bundle.forbiddenBlocks.filter((block) =>
    inside(bundle.window, block.at),
  );

  check(
    gate,
    "low-medium-merged",
    applied.length >= 1,
    `${applied.length} low/medium change(s) applied in window`,
  );
  check(
    gate,
    "forbidden-zero",
    forbidden.length === 0,
    `${forbidden.length} forbidden block(s) in window`,
  );
  check(
    gate,
    "high-risk-approved",
    highRiskUnlinked.length === 0,
    highRiskApplied.length === 0
      ? `no high-risk change was applied (${highRisk.length} high-risk change(s) in window)`
      : `${highRiskUnlinked.length}/${highRiskApplied.length} applied high-risk change(s) lack an approved high-risk link; ${highRiskApproved.length} approved`,
  );

  gate.evidence.push(
    ...applied
      .slice(0, 10)
      .map(
        (change) =>
          `code:${change.iterationId}/${change.taskId} risk=${change.risk} source=${change.source} commit=${change.commitSha ?? "none"}`,
      ),
    ...highRisk
      .slice(0, 10)
      .map(
        (change) =>
          `code:${change.iterationId}/${change.taskId} risk=high applied=${isApplied(change)} approval=${change.approvalRef ?? "none"} status=${change.approvalStatus ?? "none"} riskClass=${change.approvalRisk ?? "none"}`,
      ),
    `security:forbidden_blocks n=${forbidden.length}`,
  );
  gate.metrics = {
    changes: changes.length,
    lowMediumApplied: applied.length,
    highRiskChanges: highRisk.length,
    highRiskApplied: highRiskApplied.length,
    highRiskApproved: highRiskApproved.length,
    forbiddenBlocks: forbidden.length,
  };
  return gate;
}

function gateObserverBoundary(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G5",
    "观察者边界",
    "常规周期人工干预 ≤ 高风险审批 + 发布/预算确认；所有干预有审计与理由。",
  );
  const interventions = bundle.interventions
    .filter((item) => inside(bundle.window, item.at))
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
  const routine = interventions.filter((item) => item.category === "routine");
  const approvals = interventions.filter(
    (item) => item.category === "high-risk-approval",
  );
  const highRiskApprovals = approvals.filter((item) => item.risk === "high");
  const untypedApprovals = approvals.filter((item) => item.risk === null);
  const releases = interventions.filter(
    (item) => item.category === "release-budget",
  );
  const missingReason = interventions.filter(
    (item) => (item.reason ?? "").trim() === "",
  );
  const missingActor = interventions.filter(
    (item) => item.actor.trim() === "" || item.actor === "unattributed",
  );
  const auditSource = bundle.sources.some(
    (source) =>
      source.status === "ok" &&
      (source.id === "store-db" || source.id === "kitd-audit"),
  );

  check(
    gate,
    "audit-source",
    auditSource,
    auditSource
      ? "store or kitd audit is readable"
      : "no readable audit source; a zero-intervention result is not evidence",
  );
  check(
    gate,
    "reason-recorded",
    missingReason.length === 0,
    `${missingReason.length}/${interventions.length} intervention(s) lack a recorded reason`,
  );
  check(
    gate,
    "actor-recorded",
    missingActor.length === 0,
    `${missingActor.length}/${interventions.length} intervention(s) lack an attributed actor`,
  );
  check(
    gate,
    "approval-risk-recorded",
    untypedApprovals.length === 0,
    `${untypedApprovals.length}/${approvals.length} approval decision(s) lack a risk label and cannot count as high-risk`,
  );
  check(
    gate,
    "routine-budget",
    routine.length <= highRiskApprovals.length + releases.length,
    `routine=${routine.length} <= high-risk approvals=${highRiskApprovals.length} + release/budget=${releases.length}`,
  );

  const byCategory: Record<InterventionCategory, number> = {
    routine: routine.length,
    "high-risk-approval": approvals.length,
    "release-budget": releases.length,
    recovery: interventions.filter((item) => item.category === "recovery")
      .length,
  };
  gate.evidence.push(
    `store:approvals decisions=${approvals.length} high-risk=${highRiskApprovals.length}`,
    `store:kill_switches activations=${routine.length}`,
    "store:interest_profile_audits human edits included",
    `audit:kitd.jsonl recovery actions=${byCategory.recovery}`,
  );
  gate.metrics = {
    interventions: interventions.length,
    routine: byCategory.routine,
    highRiskApprovals: highRiskApprovals.length,
    approvals: approvals.length,
    untypedApprovals: untypedApprovals.length,
    releaseBudget: byCategory["release-budget"],
    recovery: byCategory.recovery,
    missingReason: missingReason.length,
    missingActor: missingActor.length,
  };
  return gate;
}

function gateRecovery(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G6",
    "恢复与不可逆",
    "RK/LKG/kill switch 演练通过，RTO ≤ 10 分钟；无双失败导致的状态漂移。",
  );
  const drills = bundle.recoveryDrills
    .filter((drill) => inside(bundle.window, drill.executedAt))
    .sort(
      (left, right) =>
        right.executedAt.localeCompare(left.executedAt) ||
        right.id.localeCompare(left.id),
    );
  const latest = drills[0];
  const rto = latest?.measuredRtoMinutes ?? null;
  const storeAvailable = bundle.sources.some(
    (source) => source.id === "store-db" && source.status === "ok",
  );

  check(
    gate,
    "store-source",
    storeAvailable,
    storeAvailable
      ? "store is readable for the incident/drift check"
      : "store is not readable; an empty incident list is not evidence",
  );
  check(
    gate,
    "drill-recorded",
    drills.length >= 1,
    `${drills.length} recovery drill(s) in window`,
  );
  check(
    gate,
    "drill-pass",
    latest?.outcome === "pass",
    latest
      ? `latest drill ${latest.id} outcome=${latest.outcome}`
      : "no latest drill",
  );
  check(
    gate,
    "rto-measured",
    rto !== null,
    rto === null
      ? "latest drill has no measured RTO"
      : `measured RTO ${rto} minute(s)`,
  );
  check(
    gate,
    "rto-target",
    rto !== null && rto <= GATE_RTO_TARGET_MINUTES,
    `target <= ${GATE_RTO_TARGET_MINUTES} minute(s)`,
  );
  check(
    gate,
    "integrity",
    latest?.integrityPass === true,
    latest ? `integrityPass=${latest.integrityPass}` : "no latest drill",
  );
  check(
    gate,
    "no-open-incidents",
    bundle.openIncidents.length === 0,
    `${bundle.openIncidents.length} open/mitigated incident(s)`,
  );

  gate.evidence.push(
    ...drills
      .slice(0, 5)
      .map(
        (drill) =>
          `drill:${drill.id} script=${drill.script} outcome=${drill.outcome} rto=${drill.measuredRtoMinutes ?? "unmeasured"}`,
      ),
    `store:incidents open=${bundle.openIncidents.length}`,
    `store:last_known_good refs=${bundle.lkgRefs.length}`,
  );
  gate.metrics = {
    drills: drills.length,
    latestOutcome: latest?.outcome ?? null,
    latestRtoMinutes: rto,
    rtoTargetMinutes: GATE_RTO_TARGET_MINUTES,
    openIncidents: bundle.openIncidents.length,
    lkgRefs: bundle.lkgRefs.length,
  };
  return gate;
}

function gateTraceability(bundle: EvidenceBundle): GateDraft {
  const gate = draft(
    "G7",
    "可追溯",
    "任一反应可在 60 秒内回答 event → rule → job → artifact → decision → rollback。",
  );
  const jobs = informationTriggerRuns(bundle);
  const jobIds = new Set(jobs.map((job) => job.triggerRunId));
  const linkedJobs = new Set(
    bundle.codeChanges
      .filter(
        (change) => change.triggerRunId && jobIds.has(change.triggerRunId),
      )
      .map((change) => change.triggerRunId),
  );
  const linkedRuns = bundle.runs.filter(
    (run) => run.triggerRunId !== null && jobIds.has(run.triggerRunId),
  );
  for (const run of linkedRuns) {
    if (run.triggerRunId !== null) {
      linkedJobs.add(run.triggerRunId);
    }
  }
  const unlinked = jobs.filter(
    (job) => job.jobId === null || job.payloadRef === null,
  );
  const tracedChanges = bundle.codeChanges.filter(
    (change) =>
      change.triggerRunId !== null && linkedJobs.has(change.triggerRunId),
  );
  const withArtifact = [
    ...tracedChanges
      .filter((change) => change.resultArtifactId !== null)
      .map((change) => `${change.iterationId}/${change.taskId}`),
    ...linkedRuns
      .filter((run) => run.artifactIds.length > 0)
      .map((run) => run.runId),
  ];

  check(
    gate,
    "reactions-present",
    jobs.length > 0,
    `${jobs.length} information trigger run(s) in window`,
  );
  check(
    gate,
    "event-and-job-links",
    jobs.length > 0 && unlinked.length === 0,
    `${unlinked.length}/${jobs.length} trigger run(s) lack jobId or payloadRef`,
  );
  check(
    gate,
    "job-to-change-link",
    tracedChanges.length + linkedRuns.length >= 1,
    `${tracedChanges.length} change(s) and ${linkedRuns.length} run(s) resolve from a reaction`,
  );
  check(
    gate,
    "artifact-link",
    withArtifact.length >= 1,
    `${withArtifact.length} traced reaction(s) carry an artifact id`,
  );
  check(
    gate,
    "decision-link",
    bundle.decisionRefs.length >= 1,
    `${bundle.decisionRefs.length} decision reference(s) recorded`,
  );
  check(
    gate,
    "rollback-link",
    bundle.lkgRefs.length >= 1,
    `${bundle.lkgRefs.length} LKG/rollback reference(s) recorded`,
  );

  gate.evidence.push(
    `store:trigger_runs n=${jobs.length}`,
    `store:iteration_runs+runs linked=${linkedJobs.size}`,
    `store:decisions n=${bundle.decisionRefs.length}`,
    `store:last_known_good n=${bundle.lkgRefs.length}`,
    "contract:docs/gate-report.md#traceability",
  );
  gate.metrics = {
    reactions: jobs.length,
    unlinked: unlinked.length,
    linkedJobs: linkedJobs.size,
    artifactLinks: withArtifact.length,
    decisions: bundle.decisionRefs.length,
    rollbackRefs: bundle.lkgRefs.length,
  };
  return gate;
}

function gateSupportConditions(
  bundle: EvidenceBundle,
  recoveryPass: boolean,
  traceabilityPass: boolean,
): GateDraft {
  const gate = draft("G8", "支撑条件", "85 原 12 条继续作为 1.0 子条件验收。");
  const changes = bundle.codeChanges.filter((change) =>
    inside(bundle.window, change.startedAt),
  );
  const succeeded = changes.filter(
    (change) =>
      isSucceeded(change) &&
      change.originKind !== null &&
      change.originKind !== "manual",
  );
  const succeededDays = new Set<string>();
  for (const change of succeeded) {
    const day = utcDay(change.startedAt);
    if (day) {
      succeededDays.add(day);
    }
  }
  const consecutive = hasConsecutiveDays([...succeededDays].sort());
  const drivers = new Set(
    bundle.triggerRuns
      .filter((run) => inside(bundle.window, run.launchedAt))
      .map((run) => run.kind),
  );
  const promotions = bundle.evolutionPromotions.filter((item) =>
    inside(bundle.window, item.at),
  );
  const promoted = promotions.some(
    (item) =>
      /promot|canary/i.test(item.action) &&
      /success|ok|applied|active/i.test(item.status ?? ""),
  );
  const rollbackEvidence =
    bundle.lkgRefs.length > 0 ||
    promotions.some((item) => /rollback|revert/i.test(item.action));
  const outcomes = bundle.outcomeObservations.filter((item) =>
    inside(bundle.window, item.at),
  );
  const forbidden = bundle.forbiddenBlocks.filter((item) =>
    inside(bundle.window, item.at),
  );
  const supervisorChildren = new Set(bundle.supervisor?.children ?? []);
  const resident =
    bundle.supervisor?.present === true &&
    ["worker", "autopilot", "gateway"].every((child) =>
      supervisorChildren.has(child),
    );
  const coldStart = bundle.coldStart;
  const tthwMinutes = coldStart?.tthwMinutes ?? null;

  check(
    gate,
    "S1.one-command",
    resident,
    bundle.supervisor
      ? `supervisor present=${bundle.supervisor.present} children=${[...supervisorChildren].sort().join(",") || "none"}`
      : "no supervisor state record",
  );
  check(
    gate,
    "S2.zero-human-loop",
    succeeded.length >= 1,
    `${succeeded.length} autonomous succeeded change(s)`,
  );
  check(
    gate,
    "S3.two-consecutive-periods",
    consecutive,
    `autonomous success days=${succeededDays.size} consecutive=${consecutive}`,
  );
  check(
    gate,
    "S4.multi-driver",
    ["event", "schedule", "information"].every((kind) => drivers.has(kind)),
    `trigger kinds=${[...drivers].sort().join(",") || "none"}`,
  );
  check(
    gate,
    "S5.self-optimization",
    promoted && rollbackEvidence && outcomes.length > 0,
    `promotions=${promotions.length} promoted=${promoted} rollbackEvidence=${rollbackEvidence} outcomes=${outcomes.length}`,
  );
  check(gate, "S6.recovery-drill", recoveryPass, "see G6");
  const storeAvailable = bundle.sources.some(
    (source) => source.id === "store-db" && source.status === "ok",
  );
  check(
    gate,
    "S7.security",
    storeAvailable && forbidden.length === 0,
    storeAvailable
      ? `${forbidden.length} forbidden block(s) in window`
      : "store is not readable; zero forbidden blocks is not evidence",
  );
  check(gate, "S8.traceability", traceabilityPass, "see G7");
  check(
    gate,
    "S9.concurrency",
    bundle.concurrencyEvidence.length > 0,
    `${bundle.concurrencyEvidence.length} concurrency/lock probe record(s)`,
  );
  check(
    gate,
    "S10.workshop",
    bundle.installedComponents.length > 0 && bundle.workshopEvidence.length > 0,
    `components=${bundle.installedComponents.length} workshop records=${bundle.workshopEvidence.length}`,
  );
  check(
    gate,
    "S11.pixel-factory",
    bundle.factoryEvidence.length > 0,
    `${bundle.factoryEvidence.length} factory record(s)`,
  );
  check(
    gate,
    "S12.zero-config",
    coldStart?.packageOk === true && tthwMinutes !== null && tthwMinutes <= 5,
    coldStart === null
      ? "no cold-start evidence"
      : `packageOk=${coldStart.packageOk} missing=${coldStart.missing.length} tthw=${tthwMinutes ?? "unmeasured"}`,
  );

  gate.evidence.push(
    "plan:85-autonomy-1.0.md §5.2 support conditions 1-12",
    `store:activity_events concurrency=${bundle.concurrencyEvidence.length} workshop=${bundle.workshopEvidence.length} factory=${bundle.factoryEvidence.length}`,
    `packs:components_lock n=${bundle.installedComponents.length}`,
    `signals:outcomes n=${outcomes.length}`,
  );
  gate.metrics = {
    autonomousSucceeded: succeeded.length,
    autonomousDays: succeededDays.size,
    triggerKinds: [...drivers].sort().join(",") || null,
    promotions: promotions.length,
    outcomes: outcomes.length,
    concurrencyRecords: bundle.concurrencyEvidence.length,
    workshopRecords: bundle.workshopEvidence.length,
    factoryRecords: bundle.factoryEvidence.length,
    coldStartTthwMinutes: coldStart?.tthwMinutes ?? null,
  };
  return gate;
}

function draft(id: GateId, title: string, requirement: string): GateDraft {
  return {
    id,
    title,
    requirement,
    checks: [],
    evidence: [],
    gaps: [],
    metrics: {},
  };
}

function check(
  gate: GateDraft,
  code: string,
  ok: boolean,
  detail: string,
): void {
  gate.checks.push({ code, ok, detail });
  if (!ok) {
    gate.gaps.push({ code: `${gate.id}.${code}`, detail });
  }
}

function finishGate(gate: GateDraft): GateResult {
  return {
    id: gate.id,
    title: gate.title,
    requirement: gate.requirement,
    status: gate.gaps.length === 0 ? "pass" : "gap",
    checks: gate.checks,
    evidence: gate.evidence,
    gaps: [...gate.gaps].sort((left, right) =>
      left.code.localeCompare(right.code),
    ),
    metrics: gate.metrics,
  };
}

function informationTriggerRuns(bundle: EvidenceBundle): TriggerRunEvidence[] {
  return bundle.triggerRuns
    .filter(
      (run) =>
        run.kind === "information" && inside(bundle.window, run.launchedAt),
    )
    .sort(
      (left, right) =>
        left.launchedAt.localeCompare(right.launchedAt) ||
        left.triggerRunId.localeCompare(right.triggerRunId),
    );
}

function isLowOrMedium(risk: string): boolean {
  return risk === "low" || risk === "medium";
}

function isApplied(change: CodeChangeEvidence): boolean {
  const status = (change.applyStatus ?? "").toLowerCase();
  return (
    status === "applied" ||
    status === "merged" ||
    status === "committed" ||
    (change.commitSha ?? "") !== ""
  );
}

/** An applied high-risk change counts only with a decided, labelled approval. */
function isApprovedHighRiskLink(change: CodeChangeEvidence): boolean {
  return (
    change.approvalRef !== null &&
    change.approvalStatus === "approved" &&
    change.approvalRisk === "high"
  );
}

function isSucceeded(change: CodeChangeEvidence): boolean {
  const status = change.status.toLowerCase();
  return status === "succeeded" || status === "completed" || status === "done";
}

function hasConsecutiveDays(days: string[]): boolean {
  let previous: number | null = null;
  for (const day of days) {
    const ms = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isFinite(ms)) {
      if (previous !== null && ms - previous === DAY_MS) {
        return true;
      }
      previous = ms;
    }
  }
  return false;
}

function inside(window: GateWindow, value: string | null | undefined): boolean {
  const ms = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    return false;
  }
  return ms >= Date.parse(window.start) && ms <= Date.parse(window.end);
}

function utcDay(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
