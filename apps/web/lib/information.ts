import {
  DEFAULT_INTEREST_PROFILE,
  type InterestProfile,
  type SignalThresholds,
} from "@kit/core";
import { type InterestProfileDraft, draftInterestProfile } from "@kit/source";
import type {
  InformationEventRecord,
  InterestProfileAuditRecord,
  SignalAuditRecord,
} from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

/**
 * Information surface data (98 §3.2/§3.4, issue #128).
 *
 * The console shows the current InterestProfile, its version history and audit
 * trail, recent scored events and the stored signal audits. Drafting is a
 * deterministically labeled `heuristic` proposal (D-64); saving appends a new
 * profile version — nothing is written on draft.
 */

export interface InformationView {
  workspaceId: string;
  profile: InterestProfile;
  persisted: boolean;
  versions: InterestProfile[];
  audit: InterestProfileAuditRecord[];
  events: InformationEventRecord[];
  signals: SignalAuditRecord[];
}

export async function loadInformationView(
  workspaceId = "default",
): Promise<InformationView> {
  await ensureStoreSchema();
  const store = getStore();
  const [current, versions, audit, events, signals] = await Promise.all([
    store.interestProfiles.getCurrent(workspaceId),
    store.interestProfiles.listVersions(workspaceId, 8),
    store.interestProfiles.listAudit(workspaceId, 8),
    store.information.listEvents({ workspaceId, limit: 25 }),
    store.interestProfiles.listSignals({ workspaceId, limit: 25 }),
  ]);
  return {
    workspaceId,
    profile: current ?? DEFAULT_INTEREST_PROFILE,
    persisted: current !== null,
    versions,
    audit,
    events,
    signals,
  };
}

export function draftProfile(
  intent: string,
  current: InterestProfile | null,
): InterestProfileDraft {
  return draftInterestProfile(intent, current);
}

export interface SaveProfileRequestBody {
  workspaceId?: string;
  topics: string[];
  entities: string[];
  exclusions: string[];
  thresholds: SignalThresholds;
  dailyBudgetCny: number;
  updatedBy: "human" | "ai";
  rationale: string;
  expectedVersion?: number;
}

/** Parse and validate the JSON body of `PUT /api/information`. */
export function parseSaveProfileBody(body: unknown): SaveProfileRequestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid JSON body");
  }
  const record = body as Record<string, unknown>;
  const thresholds = record.thresholds;
  if (
    !thresholds ||
    typeof thresholds !== "object" ||
    Array.isArray(thresholds)
  ) {
    throw new Error("thresholds are required");
  }
  const thresholdRecord = thresholds as Record<string, unknown>;
  const parsedThresholds: SignalThresholds = {
    relevance: ratio(thresholdRecord.relevance, "thresholds.relevance"),
    novelty: ratio(thresholdRecord.novelty, "thresholds.novelty"),
    urgency: ratio(thresholdRecord.urgency, "thresholds.urgency"),
  };
  const updatedBy =
    record.updatedBy === "ai" || record.updatedBy === "human"
      ? record.updatedBy
      : undefined;
  if (!updatedBy) {
    throw new Error("updatedBy must be human or ai");
  }
  const rationale =
    typeof record.rationale === "string" ? record.rationale.trim() : "";
  if (!rationale) {
    throw new Error("a one-sentence rationale is required");
  }
  const dailyBudgetCny = number(record.dailyBudgetCny, "dailyBudgetCny");
  if (dailyBudgetCny < 0) {
    throw new Error("dailyBudgetCny must be non-negative");
  }
  const expectedVersion =
    record.expectedVersion === undefined
      ? undefined
      : integer(record.expectedVersion, "expectedVersion");

  return {
    ...(typeof record.workspaceId === "string" && record.workspaceId
      ? { workspaceId: record.workspaceId }
      : {}),
    topics: stringList(record.topics, "topics"),
    entities: stringList(record.entities, "entities"),
    exclusions: stringList(record.exclusions, "exclusions"),
    thresholds: parsedThresholds,
    dailyBudgetCny,
    updatedBy,
    rationale,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
}

export async function saveProfile(input: SaveProfileRequestBody) {
  await ensureStoreSchema();
  const store = getStore();
  return store.interestProfiles.saveProfile({
    ...input,
    actor: "web:console",
  });
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${field} must be an array of strings`);
    }
    const trimmed = item.trim();
    if (trimmed) {
      result.push(trimmed);
    }
  }
  return result;
}

function ratio(value: unknown, field: string): number {
  const parsed = number(value, field);
  if (parsed < 0 || parsed > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return parsed;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}
