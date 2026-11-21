import { z } from "zod";
import type { SignalBlock } from "./information";
import type { PriorityClass } from "./quota";

/**
 * ReactionRule contract (98 §2/§3.3, 96 §5.6 T6, issue #129).
 *
 * A ReactionRule maps an information event to one pre-declared job. It is the
 * authoring/declaration layer above `Trigger` + `EventRoute`; the trigger plane
 * maps each rule at dispatch time and keeps a single runtime semantics.
 *
 * Human-only edits: observers create/update rules through the console or CLI.
 * An AI may produce a {@link ReactionRuleDraft} proposal (D-64) but the save
 * path accepts `source: "human"` only, so a model can never make a rule take
 * effect by itself.
 */

export const reactionRuleSourceSchema = z.enum(["human", "ai"]);

export type ReactionRuleSource = z.infer<typeof reactionRuleSourceSchema>;

/** Thresholds the event's SignalBlock must clear before the rule may fire. */
export const reactionMinSignalsSchema = z.object({
  relevance: z.number().min(0).max(1).optional(),
  novelty: z.number().min(0).max(1).optional(),
  urgency: z.number().min(0).max(1).optional(),
});

export type ReactionMinSignals = z.infer<typeof reactionMinSignalsSchema>;

/**
 * Deterministic matching inputs. Empty topic/entity lists mean "no constraint";
 * entries inside a list are any-of. All populated groups are ANDed.
 */
export const reactionRuleMatchSchema = z.object({
  /** Exact `information.<name>` or a prefix wildcard such as `information.*`. */
  eventType: z.string().min(1).default("information.*"),
  topics: z.array(z.string().min(1)).default([]),
  entities: z.array(z.string().min(1)).default([]),
  minSignals: reactionMinSignalsSchema.default({}),
});

export type ReactionRuleMatch = z.infer<typeof reactionRuleMatchSchema>;

export const reactionBudgetSchema = z.object({
  dailyRuns: z.number().int().positive().optional(),
  dailyCostCny: z.number().nonnegative().optional(),
});

export type ReactionBudget = z.infer<typeof reactionBudgetSchema>;

/**
 * Route declaration. `packRun` targets need a workflow; `iteration` targets
 * need a goal (the mission template can supply it).
 */
export const reactionRuleTargetSchema = z
  .object({
    packDir: z.string().min(1),
    jobKind: z.enum(["packRun", "iteration"]).default("packRun"),
    workflow: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    maxTasks: z.number().int().min(1).max(20).optional(),
    maxRepair: z.number().int().min(0).max(5).optional(),
    coder: z.enum(["dsh", "codex", "opencode", "command"]).optional(),
    applyMode: z.enum(["none", "low", "low-medium"]).optional(),
  })
  .superRefine((target, ctx) => {
    if (target.jobKind === "packRun" && !target.workflow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workflow is required for a packRun target",
        path: ["workflow"],
      });
    }
    if (target.jobKind === "iteration" && !target.goal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "goal is required for an iteration target",
        path: ["goal"],
      });
    }
  });

export type ReactionRuleTarget = z.infer<typeof reactionRuleTargetSchema>;

/**
 * Approval metadata. Enforcement stays job-level (96 §5.2); information origins
 * are in the default auto-approval scope (core/autopilot.ts). `maxRisk` is the
 * risk ceiling recorded on the mapped route.
 */
export const reactionRuleApprovalSchema = z.object({
  autoApprove: z.boolean().default(true),
  maxRisk: z.enum(["low", "medium", "high"]).default("low"),
});

export type ReactionRuleApproval = z.infer<typeof reactionRuleApprovalSchema>;

export const reactionRuleSchema = z.object({
  ruleId: z.string().min(1),
  workspaceId: z.string().min(1).default("default"),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  match: reactionRuleMatchSchema,
  target: reactionRuleTargetSchema,
  /** Rendered as evidence text (packRun) or goal (iteration) at dispatch. */
  missionTemplate: z.string().min(1).optional(),
  runMode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
  budget: reactionBudgetSchema.optional(),
  approval: reactionRuleApprovalSchema.default({
    autoApprove: true,
    maxRisk: "low",
  }),
  /** Higher priority reacts first; ties break on ruleId (stable). */
  priority: z.number().int().min(-100).max(100).default(0),
  version: z.number().int().nonnegative(),
  source: reactionRuleSourceSchema,
  rationale: z.string().min(1),
  updatedAt: z.string().datetime().optional(),
});

export type ReactionRule = z.infer<typeof reactionRuleSchema>;

/**
 * Observer save payload. `source` is pinned to `human`: AI proposals never
 * reach this schema (they stay in {@link ReactionRuleDraft} and are edited).
 */
export const reactionRuleSaveInputSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  ruleId: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  match: reactionRuleMatchSchema,
  target: reactionRuleTargetSchema,
  missionTemplate: z.string().min(1).optional(),
  runMode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
  budget: reactionBudgetSchema.optional(),
  approval: reactionRuleApprovalSchema.optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  source: z.literal("human").default("human"),
  rationale: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type ReactionRuleSaveInput = z.input<typeof reactionRuleSaveInputSchema>;

/** AI-only proposal shape; never persisted until an observer saves it. */
export interface ReactionRuleDraft {
  name: string;
  match: ReactionRuleMatch;
  target: {
    packDir: string;
    jobKind: "packRun" | "iteration";
    workflow?: string;
    goal?: string;
  };
  missionTemplate: string;
  runMode: "DRY_RUN" | "LIVE";
  budget?: ReactionBudget;
  approval: ReactionRuleApproval;
  priority: number;
  rationale: string;
  model: "heuristic";
}

/** Hard cap on how many rules one event may fire (storm protection). */
export const REACTION_MAX_PER_EVENT_DEFAULT = 3;
export const REACTION_MAX_PER_EVENT_CEILING = 10;

export interface ReactionMissionContext {
  eventId: string;
  eventType: string;
  title: string;
  url?: string;
  sourceId: string;
  entities?: string[];
}

/** Fill `{eventId}`, `{title}`, `{url}`, `{sourceId}`, `{eventType}` spans. */
export function renderReactionMission(
  template: string,
  context: ReactionMissionContext,
): string {
  const entities = (context.entities ?? []).join(", ");
  const values: Record<string, string> = {
    eventId: context.eventId,
    eventType: context.eventType,
    title: context.title,
    url: context.url ?? "",
    sourceId: context.sourceId,
    entities,
  };
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
    return values[key] ?? match;
  });
}

/**
 * Deterministic priority lane for a reaction (60 §2 P0–P3). High-risk events
 * get P1; otherwise urgency picks P2/P3. No model is consulted.
 */
export function reactionPriorityForSignals(
  signals: SignalBlock | undefined,
): PriorityClass {
  if (!signals) {
    return "P3";
  }
  if (signals.risk >= 0.7) {
    return "P1";
  }
  if (signals.urgency >= 0.8) {
    return "P2";
  }
  return "P3";
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "from",
  "about",
  "into",
  "that",
  "this",
  "when",
  "then",
  "run",
  "runs",
  "workflow",
  "pack",
  "rule",
  "reaction",
  "react",
  "information",
  "event",
  "events",
  "关注",
  "运行",
  "信息",
  "规则",
  "事件",
]);

/**
 * Deterministic intent → rule draft (D-64). This is the labeled `heuristic`
 * proposal path: it fills topics/target hints from the sentence, and the
 * observer edits and approves in the console. Nothing is persisted here.
 */
export function draftReactionRule(
  intent: string,
  base?: Pick<
    ReactionRule,
    | "name"
    | "match"
    | "target"
    | "missionTemplate"
    | "runMode"
    | "budget"
    | "approval"
    | "priority"
  > | null,
): ReactionRuleDraft {
  const trimmed = intent.trim();
  const lower = trimmed.toLowerCase();
  const topics = unique([
    ...(base?.match.topics ?? []),
    ...extractTerms(trimmed),
  ]).slice(0, 6);
  const eventType =
    extractEventType(lower) ?? base?.match.eventType ?? "information.*";
  const packDir =
    extractAssignment(lower, "pack") ?? base?.target.packDir ?? "";
  const workflow =
    extractAssignment(lower, "workflow") ?? base?.target.workflow ?? "";
  const dailyRuns = extractDailyRuns(lower) ?? base?.budget?.dailyRuns ?? 3;
  const priority = base?.priority ?? 0;

  return {
    name:
      base?.name ?? `Reaction: ${truncate(trimmed || "information event", 60)}`,
    match: {
      eventType,
      topics,
      entities: base?.match.entities ?? [],
      minSignals:
        base?.match.minSignals ??
        ({ relevance: 0.5 } satisfies ReactionMinSignals),
    },
    target: {
      packDir,
      jobKind: base?.target.jobKind ?? "packRun",
      ...(workflow ? { workflow } : {}),
      ...(base?.target.goal ? { goal: base.target.goal } : {}),
    },
    missionTemplate:
      base?.missionTemplate ?? "React to {title} ({eventId}) from {sourceId}",
    runMode: base?.runMode ?? "DRY_RUN",
    budget: {
      dailyRuns,
      ...(base?.budget?.dailyCostCny !== undefined
        ? { dailyCostCny: base.budget.dailyCostCny }
        : {}),
    },
    approval: base?.approval ?? { autoApprove: true, maxRisk: "low" },
    priority,
    rationale: trimmed
      ? `Heuristic draft for "${truncate(trimmed, 80)}": match ${eventType}, ${topics.length} topic(s), ${dailyRuns} run(s)/day.`
      : "Heuristic draft from the current rule; no new intent supplied.",
    model: "heuristic",
  };
}

function extractTerms(text: string): string[] {
  const matches =
    text.match(/[A-Za-z0-9][A-Za-z0-9.+#-]{1,}|[㐀-鿿]{2,}/g) ?? [];
  return matches
    .map((term) => term.toLowerCase())
    .filter((term) => !STOPWORDS.has(term) && !/^\d+$/.test(term));
}

function extractEventType(text: string): string | undefined {
  const match = text.match(/\binformation\.[a-z0-9.-]+/i);
  return match?.[0]?.toLowerCase();
}

function extractAssignment(text: string, key: string): string | undefined {
  const match = text.match(
    new RegExp(
      `\\b${key}\\b\\s*(?:[:=]|is|为|是)?\\s*["“]?([a-z0-9][a-z0-9_-]*)`,
    ),
  );
  return match?.[1];
}

function extractDailyRuns(text: string): number | undefined {
  const match = text.match(/(\d+)\s*(?:runs?|次)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
