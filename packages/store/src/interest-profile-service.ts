import {
  DEFAULT_INTEREST_PROFILE,
  type InterestProfile,
  type InterestUpdatedBy,
  type SignalBlock,
  type SignalFlag,
  type SignalThresholds,
  interestProfileSchema,
  newId,
  signalBlockSchema,
} from "@kit/core";
import type { SqlClient } from "./db";

/**
 * InterestProfile + signal persistence (98 §2/§3.2, issue #128).
 *
 * Three append-only stores back the scoring loop:
 * - `interest_profiles`: one immutable row per version; the highest version
 *   per workspace is current. Edits never overwrite a row, so a score can
 *   always be traced to the profile that produced it.
 * - `interest_profile_audits`: one audit row per version change (actor,
 *   rationale, before/after) written in the same transaction as the version.
 * - `information_signal_audits`: the signal block recorded at ingest time.
 *   `ON CONFLICT DO NOTHING` keeps historical scores from being silently
 *   rewritten when a later profile changes thresholds.
 */

export interface InterestProfileStore {
  sql: SqlClient;
}

export interface InterestProfileAuditRecord {
  auditId: string;
  workspaceId: string;
  profileId: string;
  version: number;
  action: "create" | "update";
  actor: string;
  rationale: string;
  before: InterestProfile | null;
  after: InterestProfile | null;
  occurredAt: string;
}

export interface SignalAuditRecord {
  eventId: string;
  workspaceId: string;
  profileVersion: number;
  model: SignalBlock["model"];
  relevance: number;
  novelty: number;
  urgency: number;
  risk: number;
  confidence: number;
  passes: boolean;
  flags: SignalFlag[];
  reasons: string[];
  scoredAt: string;
  createdAt: string;
}

export interface SaveInterestProfileInput {
  workspaceId?: string;
  topics: string[];
  entities: string[];
  exclusions: string[];
  thresholds: SignalThresholds;
  dailyBudgetCny: number;
  updatedBy: InterestUpdatedBy;
  /** Required one-sentence rationale (D-64). */
  rationale: string;
  /** Audit actor; defaults to `updatedBy`. */
  actor?: string;
  /** Optimistic concurrency: reject if the current version differs. */
  expectedVersion?: number;
  updatedAt?: string;
}

export interface RecordSignalInput {
  eventId: string;
  workspaceId?: string;
  signals: SignalBlock;
  scoredAt?: string;
  createdAt?: string;
}

export interface ListSignalsQuery {
  workspaceId?: string;
  limit?: number;
  eventId?: string;
}

interface ProfileRow {
  profile_id: string;
  workspace_id: string;
  version: number | string;
  topics: unknown;
  entities: unknown;
  exclusions: unknown;
  thresholds: unknown;
  daily_budget_cny_micro: number | string;
  updated_by: string;
  rationale: string;
  updated_at: string | Date;
}

interface AuditRow {
  audit_id: string;
  workspace_id: string;
  profile_id: string;
  version: number | string;
  action: string;
  actor: string;
  rationale: string;
  before: unknown;
  after: unknown;
  occurred_at: string | Date;
}

interface SignalRow {
  event_id: string;
  workspace_id: string;
  profile_version: number | string;
  model: string;
  relevance: number | string;
  novelty: number | string;
  urgency: number | string;
  risk: number | string;
  confidence: number | string;
  passes: boolean | number;
  flags: unknown;
  reasons: unknown;
  scored_at: string | Date;
  created_at: string | Date;
}

const DEFAULT_WORKSPACE = "default";

/** Raised when an optimistic `expectedVersion` no longer matches. */
export class InterestProfileConflictError extends Error {
  readonly code = "interest_profile_version_conflict";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `interest profile version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "InterestProfileConflictError";
  }
}

export class InterestProfileService {
  constructor(private readonly store: InterestProfileStore) {}

  private get sql(): SqlClient {
    return this.store.sql;
  }

  /** Current (highest-version) profile, or `null` before the first edit. */
  async getCurrent(
    workspaceId: string = DEFAULT_WORKSPACE,
  ): Promise<InterestProfile | null> {
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM interest_profiles
      WHERE workspace_id = ${workspaceId}
      ORDER BY version DESC
      LIMIT 1
    `;
    return rows[0] ? mapProfile(rows[0]) : null;
  }

  /** Same as {@link getCurrent} but falls back to the labeled default profile. */
  async getCurrentOrDefault(
    workspaceId: string = DEFAULT_WORKSPACE,
  ): Promise<InterestProfile> {
    return (
      (await this.getCurrent(workspaceId)) ?? {
        ...DEFAULT_INTEREST_PROFILE,
        workspaceId,
      }
    );
  }

  async listVersions(
    workspaceId: string = DEFAULT_WORKSPACE,
    limit = 20,
  ): Promise<InterestProfile[]> {
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM interest_profiles
      WHERE workspace_id = ${workspaceId}
      ORDER BY version DESC
      LIMIT ${clampInt(limit, 1, 200, 20)}
    `;
    return rows.map(mapProfile);
  }

  async listAudit(
    workspaceId: string = DEFAULT_WORKSPACE,
    limit = 20,
  ): Promise<InterestProfileAuditRecord[]> {
    const rows = await this.sql<AuditRow[]>`
      SELECT * FROM interest_profile_audits
      WHERE workspace_id = ${workspaceId}
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ${clampInt(limit, 1, 200, 20)}
    `;
    return rows.map(mapAudit);
  }

  /**
   * Append a new profile version and its audit row in one transaction. The
   * profile id is stable across versions; `version` starts at 1.
   */
  async saveProfile(input: SaveInterestProfileInput): Promise<InterestProfile> {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
    const rationale = input.rationale.trim();
    if (!rationale) {
      throw new Error(
        "interest profile changes require a one-sentence rationale",
      );
    }
    const updatedAt = input.updatedAt ?? new Date().toISOString();

    return this.sql.begin(async (tx) => {
      const rows = await tx<ProfileRow[]>`
        SELECT * FROM interest_profiles
        WHERE workspace_id = ${workspaceId}
        ORDER BY version DESC
        LIMIT 1
      `;
      const current = rows[0] ? mapProfile(rows[0]) : null;
      const actualVersion = current?.version ?? 0;
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== actualVersion
      ) {
        throw new InterestProfileConflictError(
          input.expectedVersion,
          actualVersion,
        );
      }

      const version = actualVersion + 1;
      const profile = interestProfileSchema.parse({
        profileId: current?.profileId ?? newId("prf"),
        workspaceId,
        topics: normalizeList(input.topics),
        entities: normalizeList(input.entities),
        exclusions: normalizeList(input.exclusions),
        thresholds: input.thresholds,
        dailyBudgetCny: input.dailyBudgetCny,
        version,
        updatedBy: input.updatedBy,
        rationale,
        updatedAt,
      });

      await tx`
        INSERT INTO interest_profiles (
          profile_id, workspace_id, version, topics, entities, exclusions,
          thresholds, daily_budget_cny_micro, updated_by, rationale, updated_at
        ) VALUES (
          ${profile.profileId}, ${workspaceId}, ${profile.version},
          ${JSON.stringify(profile.topics)}, ${JSON.stringify(profile.entities)},
          ${JSON.stringify(profile.exclusions)}, ${JSON.stringify(profile.thresholds)},
          ${cnyToMicro(profile.dailyBudgetCny)}, ${profile.updatedBy},
          ${profile.rationale}, ${updatedAt}
        )
      `;

      await tx`
        INSERT INTO interest_profile_audits (
          audit_id, workspace_id, profile_id, version, action, actor, rationale,
          before, after, occurred_at
        ) VALUES (
          ${newId("paud")}, ${workspaceId}, ${profile.profileId}, ${version},
          ${current ? "update" : "create"}, ${input.actor ?? input.updatedBy},
          ${rationale}, ${current ? JSON.stringify(current) : null},
          ${JSON.stringify(profile)}, ${updatedAt}
        )
      `;

      return profile;
    });
  }

  /**
   * Record the signal block for an event. First write wins, so a rescore can
   * never overwrite the score that was actually used at ingest time.
   */
  async recordSignal(input: RecordSignalInput): Promise<boolean> {
    const signals = signalBlockSchema.parse(input.signals);
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
    const scoredAt =
      input.scoredAt ?? signals.scoredAt ?? new Date().toISOString();
    const createdAt = input.createdAt ?? scoredAt;

    const inserted = await this.sql<{ event_id: string }[]>`
      INSERT INTO information_signal_audits (
        event_id, workspace_id, profile_version, model, relevance, novelty,
        urgency, risk, confidence, passes, flags, reasons, scored_at, created_at
      ) VALUES (
        ${input.eventId}, ${workspaceId}, ${signals.profileVersion},
        ${signals.model}, ${signals.relevance}, ${signals.novelty},
        ${signals.urgency}, ${signals.risk}, ${signals.confidence},
        ${signals.passes ?? false}, ${JSON.stringify(signals.flags)},
        ${JSON.stringify(signals.reasons)}, ${scoredAt}, ${createdAt}
      ) ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    return inserted.length > 0;
  }

  async listSignals(
    query: ListSignalsQuery = {},
  ): Promise<SignalAuditRecord[]> {
    const workspaceId = query.workspaceId ?? DEFAULT_WORKSPACE;
    const limit = clampInt(query.limit, 1, 500, 50);
    const eventFilter = query.eventId
      ? this.sql`AND event_id = ${query.eventId}`
      : this.sql``;
    const rows = await this.sql<SignalRow[]>`
      SELECT * FROM information_signal_audits
      WHERE workspace_id = ${workspaceId}
        ${eventFilter}
      ORDER BY scored_at DESC, event_id DESC
      LIMIT ${limit}
    `;
    return rows.map(mapSignal);
  }

  /**
   * Deterministic sample for the scoring audit (acceptance: every sampled
   * event has scores plus readable reasons). Ordered by event id so repeated
   * runs audit the same subset until new events arrive.
   */
  async sampleSignals(
    workspaceId: string = DEFAULT_WORKSPACE,
    size = 10,
  ): Promise<SignalAuditRecord[]> {
    const rows = await this.sql<SignalRow[]>`
      SELECT * FROM information_signal_audits
      WHERE workspace_id = ${workspaceId}
      ORDER BY event_id ASC
      LIMIT ${clampInt(size, 1, 500, 10)}
    `;
    return rows.map(mapSignal);
  }
}

function mapProfile(row: ProfileRow): InterestProfile {
  const thresholds = parseJson<SignalThresholds>(
    row.thresholds,
    DEFAULT_INTEREST_PROFILE.thresholds,
  );
  return {
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    topics: parseJson<string[]>(row.topics, []),
    entities: parseJson<string[]>(row.entities, []),
    exclusions: parseJson<string[]>(row.exclusions, []),
    thresholds,
    dailyBudgetCny: Number(row.daily_budget_cny_micro) / 1_000_000,
    version: Number(row.version),
    updatedBy: row.updated_by as InterestUpdatedBy,
    rationale: row.rationale,
    updatedAt: toIso(row.updated_at) ?? undefined,
  };
}

function mapAudit(row: AuditRow): InterestProfileAuditRecord {
  return {
    auditId: row.audit_id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    version: Number(row.version),
    action: row.action === "create" ? "create" : "update",
    actor: row.actor,
    rationale: row.rationale,
    before: row.before
      ? parseJson<InterestProfile | null>(row.before, null)
      : null,
    after: parseJson<InterestProfile | null>(row.after, null),
    occurredAt: toIso(row.occurred_at) ?? "",
  };
}

function mapSignal(row: SignalRow): SignalAuditRecord {
  return {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    profileVersion: Number(row.profile_version),
    model: row.model === "model" ? "model" : "heuristic",
    relevance: Number(row.relevance),
    novelty: Number(row.novelty),
    urgency: Number(row.urgency),
    risk: Number(row.risk),
    confidence: Number(row.confidence),
    passes: row.passes === true || Number(row.passes) === 1,
    flags: parseJson<SignalFlag[]>(row.flags, []),
    reasons: parseJson<string[]>(row.reasons, []),
    scoredAt: toIso(row.scored_at) ?? "",
    createdAt: toIso(row.created_at) ?? "",
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

function normalizeList(values: string[]): string[] {
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

function cnyToMicro(value: number): number {
  return Math.max(0, Math.round(value * 1_000_000));
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
