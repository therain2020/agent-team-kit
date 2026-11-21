import {
  REACTION_MAX_PER_EVENT_CEILING,
  REACTION_MAX_PER_EVENT_DEFAULT,
  type ReactionRule,
  type SignalBlock,
  reactionPriorityForSignals,
  renderReactionMission,
} from "@kit/core";
import type { InformationEventRecord } from "@kit/store";
import { appendOp } from "@kit/store";
import {
  type FireTriggerDeps,
  fireTrigger,
  loadTriggerUsage,
  resolveTriggerBudget,
  triggerBudgetSkip,
} from "./dispatch";
import {
  type EventRoute,
  type Trigger,
  type TriggerResult,
  eventRouteSchema,
  triggerSchema,
} from "./types";

/**
 * Information-driven dispatch (98 §3.3, 96 §5.6 T6, issue #129).
 *
 * Rules are matched deterministically; the model is never in this path. Every
 * match goes through the single `fireTrigger` entry, so the D-66 gate order
 * (kill switch → degraded → dedupe → trigger budget → budget ledger → start →
 * write-back) applies unchanged. This module adds no second dispatch path.
 *
 * Selection order is stable: priority descending, then ruleId ascending. A
 * rule whose daily budget is exhausted is skipped so a lower-priority rule can
 * still fire, and at most `KIT_REACTION_MAX_PER_EVENT` rules fire per event
 * (default 3, hard ceiling 10) to bound an information storm.
 */

export type ReactionDecision =
  | "pending"
  | "not-matched"
  | "disabled"
  | "fired"
  | "existing"
  | "skipped"
  | "failed"
  | "budget-exhausted"
  | "cap-reached";

export interface ReactionCandidate {
  ruleId: string;
  name: string;
  priority: number;
  enabled: boolean;
  matched: boolean;
  reasons: string[];
  decision: ReactionDecision;
  triggerRunId?: string | null;
  jobId?: string | null;
  gate?: TriggerResult["gate"];
  reason?: string | null;
}

export interface ReactionOutcome {
  eventId: string;
  workspaceId: string;
  evaluatedAt: string;
  maxReactions: number;
  candidates: ReactionCandidate[];
  matched: number;
  fired: number;
  existing: number;
  skipped: number;
  failed: number;
}

export interface ReactionDeps extends FireTriggerDeps {
  rules: readonly ReactionRule[];
  maxReactions?: number;
  fireTriggerFn?: typeof fireTrigger;
}

export interface ReactionEventView {
  eventId: string;
  eventType: string;
  title: string;
  url: string;
  sourceId: string;
  entities: string[];
  signals?: SignalBlock;
  text: string;
}

/** Event → rule → job trace entry (acceptance: every reaction is answerable). */
export interface ReactionTraceEntry {
  ruleId: string | null;
  triggerId: string;
  triggerRunId: string;
  jobId: string | null;
  status: string;
  dedupeKey: string;
  launchedAt: string;
}

const DEFAULT_MISSION = "React to {title} ({eventId}) from {sourceId}";

export function reactionTriggerId(ruleId: string): string {
  return `information:${ruleId}`;
}

export function reactionRouteId(ruleId: string): string {
  return `reaction:${ruleId}`;
}

/** Stable dedupe key for one event × rule pair. */
export function reactionDedupeKey(eventId: string, ruleId: string): string {
  return `${eventId}:${ruleId}`;
}

export function informationPayloadRef(eventId: string): string {
  return `information:${eventId}`;
}

/** Project the stored event into the fields a rule may match on. */
export function reactionEventView(
  event: InformationEventRecord,
): ReactionEventView {
  const payload = event.payload;
  const claims = payload.claims ?? [];
  const facts = payload.facts ?? [];
  const entities = unique([
    ...(payload.entities ?? []),
    ...claims.flatMap((claim) => claim.entities ?? []),
  ]);
  const text = [
    event.title,
    ...claims.map((claim) => claim.text),
    ...facts.map((fact) => fact.text),
    ...(payload.itemRefs ?? []),
    ...entities,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    title: event.title,
    url: event.url,
    sourceId: event.sourceId,
    entities,
    ...(payload.signals ? { signals: payload.signals } : {}),
    text,
  };
}

/**
 * Deterministic, explainable match. Every populated group is ANDed; entries
 * inside topics/entities are any-of. `reasons` always explain both outcomes.
 */
export function matchReactionRule(
  rule: ReactionRule,
  view: ReactionEventView,
): { matched: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let matched = true;

  if (!eventTypeMatches(rule.match.eventType, view.eventType)) {
    matched = false;
    reasons.push(
      `eventType ${view.eventType} does not match ${rule.match.eventType}`,
    );
  } else {
    reasons.push(`eventType ${view.eventType} matches ${rule.match.eventType}`);
  }

  if (rule.match.topics.length > 0) {
    const hits = rule.match.topics.filter((topic) =>
      view.text.toLowerCase().includes(topic.toLowerCase()),
    );
    if (hits.length === 0) {
      matched = false;
      reasons.push(
        `topics ${rule.match.topics.join(", ")} not found in the event text`,
      );
    } else {
      reasons.push(`topics matched: ${hits.join(", ")}`);
    }
  }

  if (rule.match.entities.length > 0) {
    const haystack = `${view.entities.join(" ")} ${view.text}`.toLowerCase();
    const hits = rule.match.entities.filter((entity) =>
      haystack.includes(entity.toLowerCase()),
    );
    if (hits.length === 0) {
      matched = false;
      reasons.push(
        `entities ${rule.match.entities.join(", ")} not found in the event`,
      );
    } else {
      reasons.push(`entities matched: ${hits.join(", ")}`);
    }
  }

  const thresholds = rule.match.minSignals;
  for (const key of ["relevance", "novelty", "urgency"] as const) {
    const threshold = thresholds[key];
    if (threshold === undefined) {
      continue;
    }
    const value = view.signals?.[key];
    if (value === undefined) {
      matched = false;
      reasons.push(`minSignals.${key} ${threshold}: event has no signal block`);
    } else if (value < threshold) {
      matched = false;
      reasons.push(`minSignals.${key} ${threshold}: scored ${value}`);
    } else {
      reasons.push(`minSignals.${key} ${threshold}: scored ${value}`);
    }
  }

  return { matched, reasons };
}

/**
 * Evaluate every rule and return a stable, explainable candidate list. Rules
 * are ordered by priority desc then ruleId asc regardless of input order.
 */
export function evaluateReactionRules(
  rules: readonly ReactionRule[],
  event: InformationEventRecord,
): ReactionCandidate[] {
  const view = reactionEventView(event);
  return [...rules]
    .sort((a, b) =>
      b.priority === a.priority
        ? a.ruleId.localeCompare(b.ruleId)
        : b.priority - a.priority,
    )
    .map((rule) => {
      const result = matchReactionRule(rule, view);
      const candidate: ReactionCandidate = {
        ruleId: rule.ruleId,
        name: rule.name,
        priority: rule.priority,
        enabled: rule.enabled,
        matched: result.matched,
        reasons: result.reasons,
        decision: !rule.enabled
          ? "disabled"
          : result.matched
            ? "pending"
            : "not-matched",
      };
      return candidate;
    });
}

/**
 * Match, select and dispatch one information event. Only `fireTrigger` starts
 * jobs; this function owns ordering, budget pre-selection and the hard cap.
 */
export async function reactToInformationEvent(
  event: InformationEventRecord,
  deps: ReactionDeps,
): Promise<ReactionOutcome> {
  const workspaceId = deps.workspaceId ?? event.workspaceId;
  const now = deps.now ?? new Date();
  const env = deps.env ?? process.env;
  const maxReactions = clampCap(
    deps.maxReactions ??
      parseCap(env.KIT_REACTION_MAX_PER_EVENT) ??
      REACTION_MAX_PER_EVENT_DEFAULT,
  );
  const dispatch = deps.fireTriggerFn ?? fireTrigger;
  const candidates = evaluateReactionRules(deps.rules, event);
  const view = reactionEventView(event);
  let firedCount = 0;

  for (const candidate of candidates) {
    if (candidate.decision !== "pending") {
      continue;
    }
    const rule = deps.rules.find((item) => item.ruleId === candidate.ruleId);
    if (!rule) {
      candidate.decision = "not-matched";
      continue;
    }
    if (firedCount >= maxReactions) {
      candidate.decision = "cap-reached";
      candidate.reason = `hard cap reached (${maxReactions} per event)`;
      continue;
    }

    const trigger = buildReactionTrigger(rule);
    const route = buildReactionRoute(rule);
    const budget = resolveTriggerBudget(route, "information", env);
    if (budget) {
      const usage = await loadTriggerUsage(
        deps.store,
        workspaceId,
        trigger,
        now,
        budget.dailyCostCny !== undefined,
      );
      const blocked = triggerBudgetSkip(budget, usage, 0);
      if (blocked) {
        candidate.decision = "budget-exhausted";
        candidate.reason = blocked;
        await recordReaction(deps, {
          workspaceId,
          eventId: event.eventId,
          rule,
          decision: candidate.decision,
          jobId: null,
          reason: blocked,
          now,
        });
        continue;
      }
    }

    const result = await dispatch(
      {
        triggerId: trigger.triggerId,
        dedupeKey: reactionDedupeKey(event.eventId, rule.ruleId),
        payloadRef: informationPayloadRef(event.eventId),
        trigger,
        route,
        eventId: event.eventId,
        reactionRuleId: rule.ruleId,
        evidenceText: renderMission(rule, view),
        priority: reactionPriorityForSignals(view.signals),
        originKind: "information",
        actor: "policy:reaction-rule",
      },
      deps,
    );

    candidate.decision = decisionFor(result);
    candidate.triggerRunId = result.triggerRunId;
    candidate.jobId = result.jobId;
    candidate.gate = result.gate;
    candidate.reason = result.reason;
    if (candidate.decision === "fired" || candidate.decision === "existing") {
      firedCount += 1;
    }
    await recordReaction(deps, {
      workspaceId,
      eventId: event.eventId,
      rule,
      decision: candidate.decision,
      jobId: result.jobId,
      reason: result.reason,
      now,
    });
  }

  return {
    eventId: event.eventId,
    workspaceId,
    evaluatedAt: now.toISOString(),
    maxReactions,
    candidates,
    matched: candidates.filter((item) => item.matched).length,
    fired: candidates.filter((item) => item.decision === "fired").length,
    existing: candidates.filter((item) => item.decision === "existing").length,
    skipped: candidates.filter(
      (item) =>
        item.decision === "skipped" ||
        item.decision === "budget-exhausted" ||
        item.decision === "cap-reached",
    ).length,
    failed: candidates.filter((item) => item.decision === "failed").length,
  };
}

/** event → rule → job trace, read from TriggerRun (no duplicated ledger). */
export async function traceReactions(
  deps: Pick<FireTriggerDeps, "store">,
  workspaceId: string,
  eventId: string,
): Promise<ReactionTraceEntry[]> {
  const rows = await deps.store.triggerRuns.list(workspaceId, {
    payloadRef: informationPayloadRef(eventId),
    limit: 100,
  });
  return rows.map((row) => ({
    ruleId: row.reactionRuleId ?? null,
    triggerId: row.triggerId,
    triggerRunId: row.triggerRunId,
    jobId: row.jobId,
    status: row.status,
    dedupeKey: row.dedupeKey,
    launchedAt: row.launchedAt,
  }));
}

function buildReactionTrigger(rule: ReactionRule): Trigger {
  return triggerSchema.parse({
    triggerId: reactionTriggerId(rule.ruleId),
    kind: "information",
    source: "reaction-rule",
    enabled: rule.enabled,
    filter: { eventType: rule.match.eventType },
    routeRef: reactionRouteId(rule.ruleId),
    reactionRuleRef: rule.ruleId,
    actor: "policy:reaction-rule",
  });
}

function buildReactionRoute(rule: ReactionRule): EventRoute {
  const target = rule.target;
  return eventRouteSchema.parse({
    routeId: reactionRouteId(rule.ruleId),
    triggerRef: reactionTriggerId(rule.ruleId),
    packDir: target.packDir,
    jobKind: target.jobKind,
    ...(target.workflow ? { workflow: target.workflow } : {}),
    ...(target.goal ? { goal: target.goal } : {}),
    ...(target.maxTasks !== undefined ? { maxTasks: target.maxTasks } : {}),
    ...(target.maxRepair !== undefined ? { maxRepair: target.maxRepair } : {}),
    ...(target.coder ? { coder: target.coder } : {}),
    ...(target.applyMode ? { applyMode: target.applyMode } : {}),
    runMode: rule.runMode,
    ...(rule.budget ? { budget: rule.budget } : {}),
    riskCeiling: rule.approval.maxRisk,
  });
}

function renderMission(rule: ReactionRule, view: ReactionEventView): string {
  return renderReactionMission(rule.missionTemplate ?? DEFAULT_MISSION, {
    eventId: view.eventId,
    eventType: view.eventType,
    title: view.title || view.eventId,
    url: view.url,
    sourceId: view.sourceId,
    entities: view.entities,
  });
}

function decisionFor(result: TriggerResult): ReactionDecision {
  if (result.dispatch === "STARTED") {
    return "fired";
  }
  if (result.dispatch === "USE_EXISTING") {
    return "existing";
  }
  if (result.dispatch === "FAILED") {
    return "failed";
  }
  if (result.gate === "trigger-budget" || result.gate === "budget-ledger") {
    return "budget-exhausted";
  }
  return "skipped";
}

async function recordReaction(
  deps: Pick<FireTriggerDeps, "store">,
  input: {
    workspaceId: string;
    eventId: string;
    rule: ReactionRule;
    decision: ReactionDecision;
    jobId: string | null;
    reason: string | null;
    now: Date;
  },
): Promise<void> {
  await appendOp(deps.store, {
    workspaceId: input.workspaceId,
    entityKind: "reaction",
    entityId: `${input.eventId}:${input.rule.ruleId}`,
    op: `reaction.${input.decision}`,
    actor: "policy:reaction-rule",
    origin: "event",
    idempotencyKey: `reaction:${input.eventId}:${input.rule.ruleId}:${input.decision}`,
    payload: {
      eventId: input.eventId,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.version,
      decision: input.decision,
      jobId: input.jobId,
      reason: input.reason,
    },
    createdAt: input.now.toISOString(),
  }).catch(() => undefined);
}

function eventTypeMatches(pattern: string, eventType: string): boolean {
  if (pattern === eventType) {
    return true;
  }
  return pattern.endsWith(".*")
    ? eventType.startsWith(pattern.slice(0, -1))
    : false;
}

function parseCap(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function clampCap(value: number): number {
  return Math.max(1, Math.min(value, REACTION_MAX_PER_EVENT_CEILING));
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
