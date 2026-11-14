import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "@kit/core";
import { type EvolutionRecord, type VariantMeta, scoreVariant } from "./evolve";
import type { EvolutionRepository } from "./repository";

export const DEFAULT_STATE = "variants/state.json";
export const DEFAULT_DECISIONS = "variants/decisions.jsonl";

export type CanaryStatus = "shadow" | "canary" | "promoted" | "rolled_back";
export type CanaryTrigger =
  | "manual"
  | "pass_rate"
  | "score"
  | "cost"
  | "incident";
export type EvolutionDecisionKind =
  | "canary_start"
  | "traffic_change"
  | "evaluate"
  | "rollback"
  | "promote";

export interface CanaryState {
  workspaceId: string;
  champion: { path: string };
  canary?: {
    path: string;
    variantId: string;
    agentId: string;
    trafficPercent: number;
    status: CanaryStatus;
    since: string;
    reason?: string;
    evalSnapshotPath?: string;
  };
}

export interface CanaryDecision {
  rollback: boolean;
  reason?: string;
  trigger?: CanaryTrigger;
}

export interface EvolutionDecisionRecord {
  decisionId: string;
  workspaceId: string;
  kind: EvolutionDecisionKind;
  variantId: string;
  agentId: string;
  fromStatus: CanaryStatus | null;
  toStatus: CanaryStatus;
  fromTrafficPercent: number;
  toTrafficPercent: number;
  trigger: CanaryTrigger;
  reason: string;
  actor: string;
  createdAt: string;
}

export interface CanaryThresholds {
  /** Maximum allowed regression in pass rate versus the champion. */
  passRate: number;
  /** Maximum allowed regression in average score versus the champion. */
  score: number;
  /** Maximum allowed cost ratio versus the champion. */
  costMultiplier: number;
}

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  passRate: 0.1,
  score: 0.1,
  costMultiplier: 1.5,
};

export interface EvaluationMetrics {
  passRate: number;
  averageScore: number;
  averageCostCny: number;
}

export interface CanaryEvaluationSummary {
  champion: EvaluationMetrics;
  candidate: EvaluationMetrics;
  delta: { passRate: number; score: number; costRatio: number };
  thresholds: CanaryThresholds;
}

export interface CanaryRoute {
  role: "canary";
  path: string;
  variantId: string;
  agentId: string;
  trafficPercent: number;
}

export interface CanaryOptions {
  workspaceId?: string;
  statePath?: string;
  decisionsPath?: string;
  repo?: EvolutionRepository;
}

export interface StartCanaryOptions extends CanaryOptions {
  trafficPercent?: number;
  actor?: string;
  evalDir?: string;
}

export interface EvaluateCanaryOptions extends CanaryOptions {
  stub?: boolean;
  archive?: string;
  incident?: string;
  actor?: string;
  evalDir?: string;
  thresholds?: CanaryThresholds;
}

export interface RollbackCanaryOptions extends CanaryOptions {
  trigger?: CanaryTrigger;
  actor?: string;
}

export interface PromoteCanaryOptions extends CanaryOptions {
  actor?: string;
}

export async function startCanary(
  baselineDir: string,
  variantDir: string,
  options: StartCanaryOptions = {},
): Promise<CanaryState> {
  const trafficPercent = options.trafficPercent ?? 0;
  assertTrafficPercent(trafficPercent);
  if (path.resolve(baselineDir) === path.resolve(variantDir)) {
    throw new Error("champion and canary must be different variants");
  }

  const variantMeta = await readMeta(variantDir);
  await readMeta(baselineDir);
  const workspaceId = workspaceFor(options);
  const stored = await loadStoredState(options);
  const fromStatus = stored.state?.canary?.status ?? null;
  const fromTrafficPercent = stored.state?.canary?.trafficPercent ?? 0;
  const status: CanaryStatus = trafficPercent > 0 ? "canary" : "shadow";
  const now = new Date().toISOString();

  const state: CanaryState = {
    workspaceId,
    champion: { path: path.resolve(baselineDir) },
    canary: {
      path: path.resolve(variantDir),
      variantId: variantMeta.id,
      agentId: variantMeta.agentId,
      trafficPercent,
      status,
      since: now,
      ...(options.evalDir
        ? { evalSnapshotPath: path.resolve(options.evalDir) }
        : {}),
    },
  };

  const decision = decisionRecord({
    workspaceId,
    kind: "canary_start",
    variantId: variantMeta.id,
    agentId: variantMeta.agentId,
    fromStatus,
    toStatus: status,
    fromTrafficPercent,
    toTrafficPercent: trafficPercent,
    trigger: "manual",
    reason:
      trafficPercent > 0
        ? `started canary at ${trafficPercent}% traffic`
        : "started canary in shadow mode",
    actor: options.actor ?? "operator",
  });

  await persistState(state, stored.version, options, decision);
  return state;
}

export async function setCanaryTraffic(
  trafficPercent: number,
  options: CanaryOptions & { actor?: string } = {},
): Promise<CanaryState> {
  assertTrafficPercent(trafficPercent);
  const stored = await loadStoredState(options);
  const state = stored.state;
  if (!state?.canary) {
    throw new Error("no canary configured");
  }
  if (state.canary.status !== "shadow" && state.canary.status !== "canary") {
    throw new Error(`canary is ${state.canary.status}`);
  }

  const fromStatus = state.canary.status;
  const fromTrafficPercent = state.canary.trafficPercent;
  const status: CanaryStatus = trafficPercent > 0 ? "canary" : "shadow";
  state.canary.trafficPercent = trafficPercent;
  state.canary.status = status;
  state.canary.since = new Date().toISOString();
  state.canary.reason = undefined;

  const decision = decisionRecord({
    workspaceId: state.workspaceId,
    kind: "traffic_change",
    variantId: state.canary.variantId,
    agentId: state.canary.agentId,
    fromStatus,
    toStatus: status,
    fromTrafficPercent,
    toTrafficPercent: trafficPercent,
    trigger: "manual",
    reason: `traffic changed from ${fromTrafficPercent}% to ${trafficPercent}%`,
    actor: options.actor ?? "operator",
  });

  await persistState(state, stored.version, options, decision);
  return state;
}

export async function evaluateCanary(
  inputs: string[],
  options: EvaluateCanaryOptions = {},
): Promise<{
  state: CanaryState;
  champion: EvolutionRecord[];
  variant: EvolutionRecord[];
  decision: CanaryDecision;
  summary: CanaryEvaluationSummary;
}> {
  const stored = await loadStoredState(options);
  const state = stored.state;
  if (
    !state?.canary ||
    (state.canary.status !== "shadow" && state.canary.status !== "canary")
  ) {
    throw new Error("no active canary");
  }
  if (inputs.length === 0) {
    throw new Error("at least one input is required");
  }

  const champion: EvolutionRecord[] = [];
  const variant: EvolutionRecord[] = [];
  const evalDir = options.evalDir ?? state.canary.evalSnapshotPath;
  if (evalDir) {
    state.canary.evalSnapshotPath = path.resolve(evalDir);
  }

  for (const input of inputs) {
    champion.push(
      await scoreVariant(
        state.champion.path,
        state.champion.path,
        input,
        state.canary.agentId,
        {
          stub: options.stub,
          archive: options.archive,
          ...(options.repo ? { repo: options.repo } : {}),
          ...(evalDir ? { evalDir } : {}),
        },
      ),
    );
    variant.push(
      await scoreVariant(
        state.canary.path,
        state.champion.path,
        input,
        state.canary.agentId,
        {
          stub: options.stub,
          archive: options.archive,
          ...(options.repo ? { repo: options.repo } : {}),
          ...(evalDir ? { evalDir } : {}),
        },
      ),
    );
  }

  const thresholds = options.thresholds ?? DEFAULT_CANARY_THRESHOLDS;
  const decision = decideRollback(champion, variant, {
    incident: options.incident,
    thresholds,
  });
  const summary = summarizeEvaluation(champion, variant, thresholds);
  const fromStatus = state.canary.status;
  const fromTrafficPercent = state.canary.trafficPercent;
  let audit: EvolutionDecisionRecord;

  if (decision.rollback) {
    const reason = decision.reason ?? "canary regression";
    state.canary.status = "rolled_back";
    state.canary.reason = reason;
    state.canary.trafficPercent = 0;
    state.canary.since = new Date().toISOString();
    audit = decisionRecord({
      workspaceId: state.workspaceId,
      kind: "rollback",
      variantId: state.canary.variantId,
      agentId: state.canary.agentId,
      fromStatus,
      toStatus: "rolled_back",
      fromTrafficPercent,
      toTrafficPercent: 0,
      trigger: decision.trigger ?? "manual",
      reason,
      actor: options.actor ?? "auto",
    });
  } else {
    state.canary.reason = undefined;
    audit = decisionRecord({
      workspaceId: state.workspaceId,
      kind: "evaluate",
      variantId: state.canary.variantId,
      agentId: state.canary.agentId,
      fromStatus,
      toStatus: fromStatus,
      fromTrafficPercent,
      toTrafficPercent: fromTrafficPercent,
      trigger: "manual",
      reason: evaluationReason(summary),
      actor: options.actor ?? "operator",
    });
  }

  await persistState(state, stored.version, options, audit);

  return { state, champion, variant, decision, summary };
}

export function decideRollback(
  champion: EvolutionRecord[],
  variant: EvolutionRecord[],
  options: { incident?: string; thresholds?: CanaryThresholds } = {},
): CanaryDecision {
  if (options.incident) {
    return {
      rollback: true,
      trigger: "incident",
      reason: `incident: ${options.incident}`,
    };
  }

  const thresholds = options.thresholds ?? DEFAULT_CANARY_THRESHOLDS;
  const championPass = passRate(champion);
  const variantPass = passRate(variant);
  const championScore = averageScore(champion);
  const variantScore = averageScore(variant);
  const championCost = averageCost(champion);
  const variantCost = averageCost(variant);

  if (variantPass < championPass - thresholds.passRate) {
    return {
      rollback: true,
      trigger: "pass_rate",
      reason: `pass rate ${variantPass.toFixed(2)} below champion ${championPass.toFixed(2)} (threshold ${thresholds.passRate.toFixed(2)})`,
    };
  }
  if (variantScore < championScore - thresholds.score) {
    return {
      rollback: true,
      trigger: "score",
      reason: `average score ${variantScore.toFixed(2)} below champion ${championScore.toFixed(2)} (threshold ${thresholds.score.toFixed(2)})`,
    };
  }
  if (
    championCost > 0 &&
    variantCost > championCost * thresholds.costMultiplier
  ) {
    return {
      rollback: true,
      trigger: "cost",
      reason: `cost ${variantCost.toFixed(4)} exceeds ${thresholds.costMultiplier}x champion ${championCost.toFixed(4)}`,
    };
  }

  return { rollback: false };
}

export async function canaryStatus(
  options: CanaryOptions = {},
): Promise<CanaryState | null> {
  return (await loadStoredState(options)).state;
}

export async function rollbackCanary(
  reason = "manual rollback",
  options: RollbackCanaryOptions = {},
): Promise<CanaryState> {
  const stored = await loadStoredState(options);
  const state = stored.state;
  if (!state?.canary) {
    throw new Error("no canary configured");
  }
  if (state.canary.status === "rolled_back") {
    return state;
  }
  if (state.canary.status === "promoted") {
    throw new Error("canary is already promoted");
  }

  const fromStatus = state.canary.status;
  const fromTrafficPercent = state.canary.trafficPercent;
  state.canary.status = "rolled_back";
  state.canary.reason = reason;
  state.canary.trafficPercent = 0;
  state.canary.since = new Date().toISOString();

  const decision = decisionRecord({
    workspaceId: state.workspaceId,
    kind: "rollback",
    variantId: state.canary.variantId,
    agentId: state.canary.agentId,
    fromStatus,
    toStatus: "rolled_back",
    fromTrafficPercent,
    toTrafficPercent: 0,
    trigger: options.trigger ?? "manual",
    reason,
    actor: options.actor ?? "operator",
  });

  await persistState(state, stored.version, options, decision);
  return state;
}

export async function markCanaryPromoted(
  reason = "promoted by evolution cycle",
  options: PromoteCanaryOptions = {},
): Promise<CanaryState> {
  const stored = await loadStoredState(options);
  const state = stored.state;
  if (!state?.canary) {
    throw new Error("no canary configured");
  }
  if (state.canary.status === "promoted") {
    return state;
  }
  if (state.canary.status === "rolled_back") {
    throw new Error("canary was rolled back");
  }

  const fromStatus = state.canary.status;
  const fromTrafficPercent = state.canary.trafficPercent;
  state.champion = { path: state.canary.path };
  state.canary.status = "promoted";
  state.canary.trafficPercent = 0;
  state.canary.reason = reason;
  state.canary.since = new Date().toISOString();

  const decision = decisionRecord({
    workspaceId: state.workspaceId,
    kind: "promote",
    variantId: state.canary.variantId,
    agentId: state.canary.agentId,
    fromStatus,
    toStatus: "promoted",
    fromTrafficPercent,
    toTrafficPercent: 0,
    trigger: "manual",
    reason,
    actor: options.actor ?? "operator",
  });

  await persistState(state, stored.version, options, decision);
  return state;
}

export function bucketForRun(runId: string): number {
  const digest = createHash("sha256").update(runId).digest();
  return digest.readUInt32BE(0) % 100;
}

export function selectRunVariant(
  state: CanaryState | null | undefined,
  runId: string,
  workspaceId: string,
): CanaryRoute | null {
  const canary = state?.canary;
  if (!state || !canary) {
    return null;
  }
  if (state.workspaceId !== workspaceId) {
    return null;
  }
  if (canary.status !== "canary" || canary.trafficPercent <= 0) {
    return null;
  }
  if (bucketForRun(runId) >= canary.trafficPercent) {
    return null;
  }
  return {
    role: "canary",
    path: canary.path,
    variantId: canary.variantId,
    agentId: canary.agentId,
    trafficPercent: canary.trafficPercent,
  };
}

export function normalizeCanaryStatus(
  value: string | null | undefined,
): CanaryStatus | null {
  if (value === "active") {
    return "canary";
  }
  if (
    value === "shadow" ||
    value === "canary" ||
    value === "promoted" ||
    value === "rolled_back"
  ) {
    return value;
  }
  return null;
}

async function readMeta(dir: string): Promise<VariantMeta> {
  const metaPath = path.join(dir, "variant.json");
  if (!existsSync(metaPath)) {
    throw new Error(`variant.json missing: ${dir}`);
  }
  return JSON.parse(await readFile(metaPath, "utf8")) as VariantMeta;
}

async function loadStoredState(options: CanaryOptions): Promise<{
  state: CanaryState | null;
  version?: number;
}> {
  if (options.repo) {
    const stored = await options.repo.getState();
    return { state: stored?.state ?? null, version: stored?.version };
  }
  return { state: await readState(options.statePath ?? DEFAULT_STATE) };
}

async function persistState(
  state: CanaryState,
  expectedVersion: number | undefined,
  options: CanaryOptions,
  decision?: EvolutionDecisionRecord,
): Promise<void> {
  if (options.repo) {
    const ok = decision
      ? await options.repo.setStateWithDecision(
          state,
          decision,
          expectedVersion,
        )
      : await options.repo.setState(state, expectedVersion);
    if (!ok) {
      throw new Error("canary state changed concurrently");
    }
    return;
  }

  await writeState(options.statePath ?? DEFAULT_STATE, state);
  if (decision) {
    await appendDecisionFile(decision, options);
  }
}

async function readState(statePath: string): Promise<CanaryState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  const raw = JSON.parse(await readFile(statePath, "utf8")) as CanaryState;
  return normalizeState(raw);
}

function normalizeState(raw: CanaryState): CanaryState {
  const workspaceId =
    typeof raw.workspaceId === "string" && raw.workspaceId
      ? raw.workspaceId
      : "default";
  const canaryRaw = raw.canary as
    | (NonNullable<CanaryState["canary"]> & { percent?: number })
    | undefined;
  if (!canaryRaw) {
    return { workspaceId, champion: raw.champion };
  }
  const trafficPercent =
    typeof canaryRaw.trafficPercent === "number"
      ? canaryRaw.trafficPercent
      : typeof canaryRaw.percent === "number"
        ? canaryRaw.percent
        : 0;
  return {
    workspaceId,
    champion: raw.champion,
    canary: {
      path: canaryRaw.path,
      variantId: canaryRaw.variantId,
      agentId: canaryRaw.agentId,
      trafficPercent,
      status: normalizeCanaryStatus(canaryRaw.status) ?? "shadow",
      since: canaryRaw.since,
      ...(canaryRaw.reason ? { reason: canaryRaw.reason } : {}),
    },
  };
}

async function writeState(
  statePath: string,
  state: CanaryState,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(statePath)), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function appendDecisionFile(
  record: EvolutionDecisionRecord,
  options: CanaryOptions,
): Promise<void> {
  const file =
    options.decisionsPath ??
    path.join(
      path.dirname(path.resolve(options.statePath ?? DEFAULT_STATE)),
      "decisions.jsonl",
    );
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

function decisionRecord(
  input: Omit<EvolutionDecisionRecord, "decisionId" | "createdAt">,
): EvolutionDecisionRecord {
  return {
    decisionId: newId("dec"),
    createdAt: new Date().toISOString(),
    ...input,
  };
}

function workspaceFor(options: CanaryOptions): string {
  return options.workspaceId ?? options.repo?.workspaceId ?? "default";
}

function assertTrafficPercent(percent: number): void {
  if (!Number.isInteger(percent) || percent < 0 || percent > 99) {
    throw new Error("trafficPercent must be an integer between 0 and 99");
  }
}

function passRate(records: EvolutionRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  return records.filter((record) => record.pass).length / records.length;
}

function averageScore(records: EvolutionRecord[]): number {
  const values = records.flatMap((record) => Object.values(record.scores));
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageCost(records: EvolutionRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  return (
    records.reduce((sum, record) => sum + record.costCny, 0) / records.length
  );
}

function summarizeEvaluation(
  champion: EvolutionRecord[],
  variant: EvolutionRecord[],
  thresholds: CanaryThresholds,
): CanaryEvaluationSummary {
  const championCost = averageCost(champion);
  const candidateCost = averageCost(variant);
  return {
    champion: {
      passRate: passRate(champion),
      averageScore: averageScore(champion),
      averageCostCny: roundCost(championCost),
    },
    candidate: {
      passRate: passRate(variant),
      averageScore: averageScore(variant),
      averageCostCny: roundCost(candidateCost),
    },
    delta: {
      passRate: roundCost(passRate(variant) - passRate(champion)),
      score: roundCost(averageScore(variant) - averageScore(champion)),
      costRatio: championCost > 0 ? roundCost(candidateCost / championCost) : 0,
    },
    thresholds,
  };
}

function evaluationReason(summary: CanaryEvaluationSummary): string {
  const { champion, candidate, delta, thresholds } = summary;
  return [
    `evaluation passed: score ${candidate.averageScore.toFixed(2)} vs champion ${champion.averageScore.toFixed(2)} (delta ${formatDelta(delta.score)})`,
    `pass rate ${candidate.passRate.toFixed(2)} vs ${champion.passRate.toFixed(2)}`,
    `cost ${delta.costRatio.toFixed(2)}x`,
    `thresholds score delta >= ${formatDelta(-thresholds.score)}, pass rate delta >= ${formatDelta(-thresholds.passRate)}, cost <= ${thresholds.costMultiplier}x`,
  ].join("; ");
}

function roundCost(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}
