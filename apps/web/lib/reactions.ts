import {
  type ReactionRule,
  type ReactionRuleDraft,
  draftReactionRule,
  reactionRuleSaveInputSchema,
} from "@kit/core";
import type { ReactionRuleAuditRecord, TriggerRunRecord } from "@kit/store";
import {
  type ReactionOutcome,
  type TriggerUsage,
  loadTriggerUsage,
  reactToInformationEvent,
} from "@kit/trigger";
import { ensureStoreSchema, getStore } from "./store";

/**
 * ReactionRule surface (98 §3.3, 96 §5.6, issue #129).
 *
 * The console shows current rules, their version audit trail, today's per-rule
 * usage and recent event → rule → job firings. Saves are observer edits: the
 * AI path only produces a labeled heuristic draft (`POST /api/reactions/draft`)
 * that nothing persists until the observer saves it.
 */

export interface ReactionsView {
  workspaceId: string;
  rules: ReactionRule[];
  audit: ReactionRuleAuditRecord[];
  reactions: TriggerRunRecord[];
  usage: Record<string, TriggerUsage>;
}

export async function loadReactionsView(
  workspaceId = "default",
): Promise<ReactionsView> {
  await ensureStoreSchema();
  const store = getStore();
  const [rules, audit, recent] = await Promise.all([
    store.reactionRules.listCurrent(workspaceId),
    store.reactionRules.listAudit(workspaceId, 10),
    store.triggerRuns.list(workspaceId, { limit: 50 }),
  ]);
  const now = new Date();
  const usage: Record<string, TriggerUsage> = {};
  for (const rule of rules) {
    usage[rule.ruleId] = await loadTriggerUsage(
      store,
      workspaceId,
      { triggerId: `information:${rule.ruleId}` },
      now,
      rule.budget?.dailyCostCny !== undefined,
    );
  }
  return {
    workspaceId,
    rules,
    audit,
    reactions: recent.filter((row) => row.kind === "information"),
    usage,
  };
}

export interface DraftReactionBody {
  intent: string;
  ruleId?: string;
  workspaceId?: string;
}

export async function draftReaction(
  body: DraftReactionBody,
): Promise<ReactionRuleDraft & { warnings: string[] }> {
  await ensureStoreSchema();
  const store = getStore();
  const workspaceId = body.workspaceId ?? "default";
  const base = body.ruleId
    ? await store.reactionRules.getCurrent(workspaceId, body.ruleId)
    : null;
  const draft = draftReactionRule(body.intent, base);
  return { ...draft, warnings: [] };
}

/**
 * Parse and persist an observer save. `source` is pinned to `human`; a request
 * carrying `source: "ai"` is rejected by the schema/store (AI only proposes).
 */
export async function saveReactionRule(
  body: unknown,
  workspaceId = "default",
): Promise<ReactionRule> {
  await ensureStoreSchema();
  const store = getStore();
  const parsed = reactionRuleSaveInputSchema.safeParse({
    workspaceId,
    ...(body && typeof body === "object" ? body : {}),
    source: "human",
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => {
          const field = issue.path.join(".") || "body";
          return `${field}: ${issue.message}`;
        })
        .join("; "),
    );
  }
  return store.reactionRules.saveRule(parsed.data, { actor: "web:console" });
}

export async function setReactionRuleEnabled(input: {
  workspaceId?: string;
  ruleId: string;
  enabled: boolean;
  rationale: string;
  expectedVersion?: number;
}): Promise<ReactionRule> {
  await ensureStoreSchema();
  const store = getStore();
  return store.reactionRules.setEnabled({
    workspaceId: input.workspaceId ?? "default",
    ruleId: input.ruleId,
    enabled: input.enabled,
    rationale: input.rationale,
    actor: "web:console",
    ...(input.expectedVersion !== undefined
      ? { expectedVersion: input.expectedVersion }
      : {}),
  });
}

export async function runReactions(
  eventId: string,
  workspaceId = "default",
): Promise<ReactionOutcome> {
  await ensureStoreSchema();
  const store = getStore();
  const event = await store.information.getEvent(workspaceId, eventId);
  if (!event) {
    throw new Error("information event not found");
  }
  const rules = await store.reactionRules.listCurrent(workspaceId);
  return reactToInformationEvent(event, {
    store,
    repoRoot: process.cwd(),
    workspaceId,
    rules,
  });
}
