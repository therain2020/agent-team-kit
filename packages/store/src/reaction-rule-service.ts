import {
  type ReactionRule,
  type ReactionRuleSaveInput,
  newId,
  reactionRuleSaveInputSchema,
  reactionRuleSchema,
} from "@kit/core";
import type { SqlClient } from "./db";

/**
 * ReactionRule persistence (98 §2/§3.3, 96 §5.6, issue #129).
 *
 * Two append-only stores mirror the InterestProfile pattern:
 * - `reaction_rules`: one immutable row per version; the highest version per
 *   `(workspace_id, rule_id)` is current. Edits never rewrite history, so a
 *   reaction can always be traced to the rule version that fired it.
 * - `reaction_rule_audits`: one row per version change with actor, rationale
 *   and before/after.
 *
 * Only observers save rules. AI proposals are returned by the draft path and
 * never enter this service, so a model cannot make a rule take effect.
 */

export interface ReactionRuleStore {
  sql: SqlClient;
}

export interface ReactionRuleAuditRecord {
  auditId: string;
  workspaceId: string;
  ruleId: string;
  version: number;
  action: "create" | "update";
  actor: string;
  rationale: string;
  before: ReactionRule | null;
  after: ReactionRule;
  occurredAt: string;
}

export interface SaveReactionRuleOptions {
  workspaceId?: string;
  actor?: string;
  updatedAt?: string;
}

interface RuleRow {
  rule_id: string;
  workspace_id: string;
  version: number | string;
  name: string;
  enabled: boolean | number;
  match_json: unknown;
  target_json: unknown;
  mission_template: string | null;
  run_mode: string;
  budget: unknown;
  approval: unknown;
  priority: number | string;
  source: string;
  rationale: string;
  updated_at: string | Date;
}

interface AuditRow {
  audit_id: string;
  workspace_id: string;
  rule_id: string;
  version: number | string;
  action: string;
  actor: string;
  rationale: string;
  before: unknown;
  after: unknown;
  occurred_at: string | Date;
}

const DEFAULT_WORKSPACE = "default";

/** Raised when an optimistic `expectedVersion` no longer matches. */
export class ReactionRuleConflictError extends Error {
  readonly code = "reaction_rule_version_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `reaction rule version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "ReactionRuleConflictError";
  }
}

/** Raised when a non-observer (AI) tries to persist a rule change. */
export class ReactionRuleApprovalError extends Error {
  readonly code = "reaction_rule_requires_approval";

  constructor() {
    super("reaction rules require an observer approval (source must be human)");
    this.name = "ReactionRuleApprovalError";
  }
}

export class ReactionRuleService {
  constructor(private readonly store: ReactionRuleStore) {}

  private get sql(): SqlClient {
    return this.store.sql;
  }

  async getCurrent(
    workspaceId: string,
    ruleId: string,
  ): Promise<ReactionRule | null> {
    const rows = await this.sql<RuleRow[]>`
      SELECT * FROM reaction_rules
      WHERE workspace_id = ${workspaceId} AND rule_id = ${ruleId}
      ORDER BY version DESC
      LIMIT 1
    `;
    return rows[0] ? mapRule(rows[0]) : null;
  }

  /** Current version of every rule, ordered by priority then rule id. */
  async listCurrent(
    workspaceId: string = DEFAULT_WORKSPACE,
    options: { enabledOnly?: boolean } = {},
  ): Promise<ReactionRule[]> {
    const rows = await this.sql<RuleRow[]>`
      SELECT r.* FROM reaction_rules r
      JOIN (
        SELECT rule_id, MAX(version) AS version
        FROM reaction_rules
        WHERE workspace_id = ${workspaceId}
        GROUP BY rule_id
      ) latest
        ON r.rule_id = latest.rule_id AND r.version = latest.version
      WHERE r.workspace_id = ${workspaceId}
      ORDER BY r.priority DESC, r.rule_id ASC
    `;
    const rules = rows.map(mapRule);
    return options.enabledOnly ? rules.filter((rule) => rule.enabled) : rules;
  }

  async listVersions(
    workspaceId: string,
    ruleId: string,
    limit = 20,
  ): Promise<ReactionRule[]> {
    const rows = await this.sql<RuleRow[]>`
      SELECT * FROM reaction_rules
      WHERE workspace_id = ${workspaceId} AND rule_id = ${ruleId}
      ORDER BY version DESC
      LIMIT ${clampInt(limit, 1, 200, 20)}
    `;
    return rows.map(mapRule);
  }

  async listAudit(
    workspaceId: string = DEFAULT_WORKSPACE,
    limit = 20,
  ): Promise<ReactionRuleAuditRecord[]> {
    const rows = await this.sql<AuditRow[]>`
      SELECT * FROM reaction_rule_audits
      WHERE workspace_id = ${workspaceId}
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ${clampInt(limit, 1, 200, 20)}
    `;
    return rows.map(mapAudit);
  }

  /**
   * Append a new rule version plus its audit row in one transaction. The rule
   * id is stable across versions; `version` starts at 1.
   */
  async saveRule(
    input: ReactionRuleSaveInput,
    options: SaveReactionRuleOptions = {},
  ): Promise<ReactionRule> {
    if ((input as { source?: unknown }).source === "ai") {
      throw new ReactionRuleApprovalError();
    }
    const parsed = reactionRuleSaveInputSchema.parse(input);
    const workspaceId =
      parsed.workspaceId ?? options.workspaceId ?? DEFAULT_WORKSPACE;
    const updatedAt = options.updatedAt ?? new Date().toISOString();

    return this.sql.begin(async (tx) => {
      const rows = parsed.ruleId
        ? await tx<RuleRow[]>`
            SELECT * FROM reaction_rules
            WHERE workspace_id = ${workspaceId} AND rule_id = ${parsed.ruleId}
            ORDER BY version DESC
            LIMIT 1
          `
        : [];
      const current = rows[0] ? mapRule(rows[0]) : null;
      const actualVersion = current?.version ?? 0;
      if (
        parsed.expectedVersion !== undefined &&
        parsed.expectedVersion !== actualVersion
      ) {
        throw new ReactionRuleConflictError(
          parsed.expectedVersion,
          actualVersion,
        );
      }

      const version = actualVersion + 1;
      const rule = reactionRuleSchema.parse({
        ruleId: current?.ruleId ?? parsed.ruleId ?? newId("rr"),
        workspaceId,
        name: parsed.name,
        enabled: parsed.enabled,
        match: parsed.match,
        target: parsed.target,
        ...(parsed.missionTemplate
          ? { missionTemplate: parsed.missionTemplate }
          : {}),
        runMode: parsed.runMode,
        ...(parsed.budget ? { budget: parsed.budget } : {}),
        approval: parsed.approval ??
          current?.approval ?? {
            autoApprove: true,
            maxRisk: "low",
          },
        priority: parsed.priority,
        version,
        source: parsed.source,
        rationale: parsed.rationale,
        updatedAt,
      });

      await tx`
        INSERT INTO reaction_rules (
          rule_id, workspace_id, version, name, enabled, match_json,
          target_json, mission_template, run_mode, budget, approval, priority,
          source, rationale, updated_at
        ) VALUES (
          ${rule.ruleId}, ${workspaceId}, ${rule.version}, ${rule.name},
          ${rule.enabled}, ${JSON.stringify(rule.match)},
          ${JSON.stringify(rule.target)},
          ${rule.missionTemplate ?? null}, ${rule.runMode},
          ${rule.budget ? JSON.stringify(rule.budget) : null},
          ${JSON.stringify(rule.approval)}, ${rule.priority}, ${rule.source},
          ${rule.rationale}, ${updatedAt}
        )
      `;

      await tx`
        INSERT INTO reaction_rule_audits (
          audit_id, workspace_id, rule_id, version, action, actor, rationale,
          before, after, occurred_at
        ) VALUES (
          ${newId("rraud")}, ${workspaceId}, ${rule.ruleId}, ${version},
          ${current ? "update" : "create"}, ${options.actor ?? "web:console"},
          ${rule.rationale}, ${current ? JSON.stringify(current) : null},
          ${JSON.stringify(rule)}, ${updatedAt}
        )
      `;

      return rule;
    });
  }

  /** Observer toggle; writes a new version with the rationale required. */
  async setEnabled(input: {
    workspaceId?: string;
    ruleId: string;
    enabled: boolean;
    rationale: string;
    actor?: string;
    expectedVersion?: number;
    updatedAt?: string;
  }): Promise<ReactionRule> {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
    const current = await this.getCurrent(workspaceId, input.ruleId);
    if (!current) {
      throw new Error(`reaction rule not found: ${input.ruleId}`);
    }
    return this.saveRule(
      {
        workspaceId,
        ruleId: current.ruleId,
        name: current.name,
        enabled: input.enabled,
        match: current.match,
        target: current.target,
        ...(current.missionTemplate
          ? { missionTemplate: current.missionTemplate }
          : {}),
        runMode: current.runMode,
        ...(current.budget ? { budget: current.budget } : {}),
        approval: current.approval,
        priority: current.priority,
        source: "human",
        rationale: input.rationale,
        ...(input.expectedVersion !== undefined
          ? { expectedVersion: input.expectedVersion }
          : {}),
      },
      {
        workspaceId,
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
      },
    );
  }
}

function mapRule(row: RuleRow): ReactionRule {
  return reactionRuleSchema.parse({
    ruleId: row.rule_id,
    workspaceId: row.workspace_id,
    name: row.name,
    enabled: row.enabled === true || Number(row.enabled) === 1,
    match: parseJson(row.match_json, {}),
    target: parseJson(row.target_json, {}),
    ...(row.mission_template ? { missionTemplate: row.mission_template } : {}),
    runMode: row.run_mode,
    ...(row.budget ? { budget: parseJson(row.budget, {}) } : {}),
    approval: parseJson(row.approval, { autoApprove: true, maxRisk: "low" }),
    priority: Number(row.priority),
    version: Number(row.version),
    source: row.source,
    rationale: row.rationale,
    updatedAt: toIso(row.updated_at) ?? undefined,
  });
}

function mapAudit(row: AuditRow): ReactionRuleAuditRecord {
  return {
    auditId: row.audit_id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    version: Number(row.version),
    action: row.action === "create" ? "create" : "update",
    actor: row.actor,
    rationale: row.rationale,
    before: row.before
      ? parseJson<ReactionRule | null>(row.before, null)
      : null,
    after: parseJson<ReactionRule>(row.after, {} as ReactionRule),
    occurredAt: toIso(row.occurred_at) ?? "",
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === "object") {
    return value as T;
  }
  return fallback;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
