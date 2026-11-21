import { z } from "zod";
import { eventEnvelopeSchema } from "./event";
import { newId } from "./ids";

/**
 * Information plane contracts (98 §2, 98 §3.1).
 *
 * `InformationEvent` is a *specialization* of the canonical event envelope in
 * 20 §2.1 — it extends {@link eventEnvelopeSchema} instead of re-declaring the
 * envelope, so the schema authority stays in one place (10 §2.2 / C-01). The
 * extra fields describe what was perceived: which raw captures backed the
 * event, which claims/facts it carries, and (from I-2 on) its {@link SignalBlock}.
 *
 * Contract rules enforced here:
 * - `eventType` must live in the `information.*` family.
 * - Every claim and fact must carry provenance; items without provenance are
 *   dropped before the event is built (10 §2.2 rule 1).
 * - `captureKey` is the fetch identity `sha256(source_id + raw_bytes)`; the
 *   dedupe key derived from it is the event identity guard used by storage.
 */

export const INFORMATION_EVENT_PREFIX = "information.";

export const DEFAULT_INFORMATION_EVENT_TYPE = "information.item";

const informationEventTypeSchema = z
  .string()
  .regex(
    new RegExp(`^${INFORMATION_EVENT_PREFIX.replace(".", "\\.")}[a-z0-9.-]+$`),
    "information event type must be information.<name>",
  );

export const informationSourceKindSchema = z.enum(["passive", "active"]);

export type InformationSourceKind = z.infer<typeof informationSourceKindSchema>;

/** Sensitivity classes shared with the canonical event (20 §2.1 / 50). */
export const informationSensitivitySchema = z.enum([
  "public",
  "internal",
  "secret",
  "pii",
]);

export type InformationSensitivity = z.infer<
  typeof informationSensitivitySchema
>;

/** A raw capture reference: kept immutable and always traceable to a source. */
export const informationProvenanceSchema = z.object({
  captureKey: z.string().min(1),
  sourceId: z.string().min(1),
  contentRef: z.string().min(1),
  fetchedAt: z.string().datetime(),
});

export type InformationProvenance = z.infer<typeof informationProvenanceSchema>;

export const informationClaimSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().min(1),
  entities: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  provenance: z.array(informationProvenanceSchema).min(1),
  /** Conflicting claims are kept and flagged, never silently resolved. */
  conflict: z.boolean().default(false),
});

export type InformationClaim = z.infer<typeof informationClaimSchema>;

/** Input shape before schema defaults are applied. */
export type InformationClaimInput = z.input<typeof informationClaimSchema>;

export const informationFactSchema = z.object({
  factId: z.string().min(1),
  text: z.string().min(1),
  provenance: z.array(informationProvenanceSchema).min(1),
});

export type InformationFact = z.infer<typeof informationFactSchema>;

/** Input shape before schema defaults are applied. */
export type InformationFactInput = z.input<typeof informationFactSchema>;

/**
 * Signal block (98 §2 / §3.2, issue #128).
 *
 * Every dimension is a 0–1 score plus human-readable `reasons`. The block also
 * records *how* it was produced (`model`, `profileVersion`, `thresholds`,
 * `passes`, `flags`, `scoredAt`) so a later audit can tell which profile and
 * scorer applied at ingest time. Historical scores are immutable: the collector
 * writes the block once into the event payload and never rewrites it when the
 * profile changes — new thresholds only affect new events.
 */
export const signalScoringModelSchema = z.enum(["heuristic", "model"]);

export type SignalScoringModel = z.infer<typeof signalScoringModelSchema>;

/** Labels for content that needs the 10/50 handling path (conflict, injection). */
export const signalFlagSchema = z.enum([
  "conflict",
  "injection-suspected",
  "excluded",
  "duplicate",
]);

export type SignalFlag = z.infer<typeof signalFlagSchema>;

export const signalThresholdsSchema = z.object({
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
});

export type SignalThresholds = z.infer<typeof signalThresholdsSchema>;

export const signalBlockSchema = z.object({
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  risk: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  /** At least one readable reason; empty reasons fail the contract. */
  reasons: z.array(z.string().min(1)).min(1),
  model: signalScoringModelSchema.default("heuristic"),
  /** Profile version whose thresholds were applied when scoring. */
  profileVersion: z.number().int().nonnegative().default(0),
  /** Snapshot of the thresholds in force at scoring time. */
  thresholds: signalThresholdsSchema.optional(),
  /** Whether relevance/novelty/urgency all clear their thresholds. */
  passes: z.boolean().optional(),
  flags: z.array(signalFlagSchema).default([]),
  scoredAt: z.string().datetime().optional(),
});

export type SignalBlock = z.infer<typeof signalBlockSchema>;

/**
 * Interest profile (98 §2): what the team cares about. A human edits it, an AI
 * may only propose a draft (D-64). Every change creates a new immutable version
 * plus an audit record in the store; the profile with the highest `version` is
 * current.
 */
export const interestUpdatedBySchema = z.enum(["human", "ai"]);

export type InterestUpdatedBy = z.infer<typeof interestUpdatedBySchema>;

export const interestProfileSchema = z.object({
  profileId: z.string().min(1),
  workspaceId: z.string().min(1).default("default"),
  topics: z.array(z.string().min(1)).default([]),
  entities: z.array(z.string().min(1)).default([]),
  exclusions: z.array(z.string().min(1)).default([]),
  thresholds: signalThresholdsSchema,
  /** Daily information-spend cap in CNY; 0 means "not set". */
  dailyBudgetCny: z.number().min(0).finite().default(0),
  version: z.number().int().nonnegative(),
  updatedBy: interestUpdatedBySchema,
  /** One sentence explaining why this profile changed (D-64). */
  rationale: z.string().min(1),
  updatedAt: z.string().datetime().optional(),
});

export type InterestProfile = z.infer<typeof interestProfileSchema>;

/**
 * The implicit profile used before anyone edits one. It scores with neutral
 * relevance so the first pass still yields readable, auditable signals; it is
 * never persisted (`version: 0`).
 */
export const DEFAULT_INTEREST_PROFILE: InterestProfile =
  interestProfileSchema.parse({
    profileId: "interest_default",
    workspaceId: "default",
    topics: [],
    entities: [],
    exclusions: [],
    thresholds: { relevance: 0.5, novelty: 0.4, urgency: 0.5 },
    dailyBudgetCny: 0,
    version: 0,
    updatedBy: "human",
    rationale:
      "Default profile: no explicit topics yet, so every item is scored with neutral relevance.",
  });

export const informationEventSchema = eventEnvelopeSchema.extend({
  type: informationEventTypeSchema,
  sourceId: z.string().min(1),
  sourceKind: informationSourceKindSchema.default("passive"),
  /** Fetch identity shared with the RawCapture row. */
  captureKey: z.string().min(1),
  /** Event identity guard; unique per workspace. */
  dedupeKey: z.string().min(1),
  itemRefs: z.array(z.string().min(1)).min(1),
  entities: z.array(z.string().min(1)).default([]),
  claims: z.array(informationClaimSchema).default([]),
  facts: z.array(informationFactSchema).default([]),
  signals: signalBlockSchema.optional(),
  provenance: z.array(informationProvenanceSchema).min(1),
  sensitivity: informationSensitivitySchema.default("internal"),
});

export type InformationEvent = z.infer<typeof informationEventSchema>;

export function isInformationEventType(value: string): boolean {
  return value.startsWith(INFORMATION_EVENT_PREFIX);
}

/**
 * Event identity derived from the capture identity. Repeated fetches of the
 * same bytes collapse to one key, so a second ingest is a no-op (10 §3.1).
 */
export function computeDedupeKey(captureKey: string): string {
  return `capture:${captureKey}`;
}

export interface BuildInformationEventInput {
  workspaceId: string;
  /** Defaults to `information.item`; callers may emit corrections etc. */
  type?: string;
  sourceId: string;
  sourceKind?: InformationSourceKind;
  captureKey: string;
  /** The primary item ref; included alongside any extra `itemRefs`. */
  itemRef: string;
  itemRefs?: string[];
  /** Durable reference to the raw capture bytes. */
  contentRef: string;
  fetchedAt: string;
  publishedAt?: string;
  /** Defaults to `publishedAt ?? fetchedAt` per 10 §2.2. */
  occurredAt?: string;
  receivedAt?: string;
  entities?: string[];
  claims?: InformationClaimInput[];
  facts?: InformationFactInput[];
  signals?: SignalBlock;
  sensitivity?: InformationSensitivity;
  traceId?: string;
  eventId?: string;
}

/**
 * Build a validated {@link InformationEvent}. Claims/facts without provenance
 * are dropped (they must not enter an event), and the result is parsed by the
 * schema so callers cannot persist a malformed event.
 */
export function buildInformationEvent(
  input: BuildInformationEventInput,
): InformationEvent {
  const dedupeKey = computeDedupeKey(input.captureKey);
  const provenance: InformationProvenance[] = [
    {
      captureKey: input.captureKey,
      sourceId: input.sourceId,
      contentRef: input.contentRef,
      fetchedAt: input.fetchedAt,
    },
  ];
  const claims = (input.claims ?? []).filter(
    (claim) => claim.provenance.length > 0,
  );
  const facts = (input.facts ?? []).filter(
    (fact) => fact.provenance.length > 0,
  );
  const itemRefs = Array.from(
    new Set([input.itemRef, ...(input.itemRefs ?? [])]),
  );

  return informationEventSchema.parse({
    eventId: input.eventId ?? newId("inf"),
    type: input.type ?? DEFAULT_INFORMATION_EVENT_TYPE,
    schemaVersion: "1.0" as const,
    occurredAt: input.occurredAt ?? input.publishedAt ?? input.fetchedAt,
    receivedAt: input.receivedAt ?? input.fetchedAt,
    workspaceId: input.workspaceId,
    idempotencyKey: dedupeKey,
    traceId: input.traceId ?? newId("trc"),
    payloadRef: input.contentRef,
    sourceId: input.sourceId,
    sourceKind: input.sourceKind ?? "passive",
    captureKey: input.captureKey,
    dedupeKey,
    itemRefs,
    entities: input.entities ?? [],
    claims,
    facts,
    ...(input.signals ? { signals: input.signals } : {}),
    provenance,
    sensitivity: input.sensitivity ?? "internal",
  });
}
