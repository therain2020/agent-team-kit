import { z } from "zod";
import { type DegradedMode, isExecutionBlocked } from "./degradation";
import { newId } from "./ids";

/**
 * Artifact-level last-known-good (61 §2). An LKG pins the artifact versions a
 * workspace may fall back to while degraded; external delivery never uses an
 * unverified or expired pin.
 */
export const LKG_TTL_DAYS = 7;

export const LKG_TTL_MS = LKG_TTL_DAYS * 24 * 60 * 60 * 1000;

export const DEFAULT_LKG_TARGET_KEY = "workspace-artifacts";

export const lkgArtifactRefSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
});

export type LkgArtifactRef = z.infer<typeof lkgArtifactRefSchema>;

export const lkgStatusSchema = z.enum(["active", "superseded"]);

export type LkgStatus = z.infer<typeof lkgStatusSchema>;

export const lastKnownGoodSchema = z.object({
  lkgId: z.string().min(1),
  workspaceId: z.string().min(1),
  targetKey: z.string().trim().min(1),
  artifactRefs: z.array(lkgArtifactRefSchema).min(1),
  /** When the pinned versions were last verified by a human or evaluator. */
  verifiedAt: z.string().datetime(),
  verifier: z.string().trim().min(1),
  status: lkgStatusSchema,
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdBy: z.string().trim().min(1),
});

export type LastKnownGood = z.infer<typeof lastKnownGoodSchema>;

export const registerLastKnownGoodInputSchema = z.object({
  lkgId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  targetKey: z.string().trim().min(1).optional(),
  artifactRefs: z.array(lkgArtifactRefSchema).min(1),
  verifiedAt: z.string().datetime().optional(),
  verifier: z.string().trim().min(1),
  createdBy: z.string().trim().min(1).optional(),
  now: z.string().datetime().optional(),
});

export type RegisterLastKnownGoodInput = z.input<
  typeof registerLastKnownGoodInputSchema
>;

export class LkgContractError extends Error {
  constructor(
    readonly code:
      | "invalid_refs"
      | "missing_verifier"
      | "lkg_missing"
      | "lkg_stale"
      | "external_blocked",
    message: string,
  ) {
    super(message);
    this.name = "LkgContractError";
  }
}

/**
 * Builds an active LKG record. `verifiedAt` defaults to the registration time
 * so the pin always carries a verification timestamp; the verifier is
 * mandatory and never inferred.
 */
export function registerLastKnownGood(
  input: RegisterLastKnownGoodInput,
): LastKnownGood {
  const parsed = registerLastKnownGoodInputSchema.parse(input);
  if (parsed.artifactRefs.length === 0) {
    throw new LkgContractError(
      "invalid_refs",
      "last-known-good requires at least one artifact ref",
    );
  }

  const now = parsed.now ?? new Date().toISOString();
  const verifier = parsed.verifier;
  if (verifier.length === 0) {
    throw new LkgContractError(
      "missing_verifier",
      "last-known-good requires a verifier",
    );
  }

  return lastKnownGoodSchema.parse({
    lkgId: parsed.lkgId ?? newId("lkg"),
    workspaceId: parsed.workspaceId,
    targetKey: parsed.targetKey ?? DEFAULT_LKG_TARGET_KEY,
    artifactRefs: parsed.artifactRefs,
    verifiedAt: parsed.verifiedAt ?? now,
    verifier,
    status: "active",
    supersedes: null,
    supersededBy: null,
    createdAt: now,
    createdBy: parsed.createdBy ?? verifier,
  });
}

export interface LkgVerification {
  state: "verified" | "stale";
  verifiedAt: string;
  verifier: string;
  ageMs: number;
  expiresAt: string;
  reason: string | null;
}

/**
 * A pin is verified for 7 days from `verifiedAt`. Exactly 7 days still counts
 * as fresh; one millisecond past it degrades to internal-only.
 */
export function lkgVerification(
  lkg: Pick<LastKnownGood, "verifiedAt" | "verifier">,
  now: string = new Date().toISOString(),
  ttlMs: number = LKG_TTL_MS,
): LkgVerification {
  const verifiedAtMs = Date.parse(lkg.verifiedAt);
  const nowMs = Date.parse(now);
  const verifier = lkg.verifier.trim();
  const validTimestamps =
    Number.isFinite(verifiedAtMs) && Number.isFinite(nowMs);
  const ageMs = validTimestamps
    ? Math.max(0, nowMs - verifiedAtMs)
    : Number.POSITIVE_INFINITY;
  const expiresAt = Number.isFinite(verifiedAtMs)
    ? new Date(verifiedAtMs + ttlMs).toISOString()
    : lkg.verifiedAt;

  let reason: string | null = null;
  if (!Number.isFinite(verifiedAtMs)) {
    reason = "verified_at is not a valid timestamp";
  } else if (verifier.length === 0) {
    reason = "verified_at has no verifier";
  } else if (ageMs > ttlMs) {
    reason = `not re-verified within ${Math.round(ttlMs / 86_400_000)} days (expired ${expiresAt})`;
  }

  return {
    state: reason === null ? "verified" : "stale",
    verifiedAt: lkg.verifiedAt,
    verifier,
    ageMs,
    expiresAt,
    reason,
  };
}

export function isLkgFresh(
  lkg: Pick<LastKnownGood, "verifiedAt" | "verifier">,
  now: string = new Date().toISOString(),
  ttlMs: number = LKG_TTL_MS,
): boolean {
  return lkgVerification(lkg, now, ttlMs).state === "verified";
}

/**
 * External use guard: an LKG must exist, carry a verifier, and be inside the
 * 7-day window. Anything else is internal-only.
 */
export function assertExternallyVerified(
  lkg: LastKnownGood | null | undefined,
  now: string = new Date().toISOString(),
): LkgVerification {
  if (!lkg) {
    throw new LkgContractError(
      "lkg_missing",
      "no last-known-good is registered for external delivery",
    );
  }
  const verification = lkgVerification(lkg, now);
  if (verification.state !== "verified") {
    throw new LkgContractError(
      "lkg_stale",
      `last-known-good ${lkg.lkgId} is internal-only: ${verification.reason}`,
    );
  }
  return verification;
}

/**
 * Applies a switch transition: the current active pins are superseded and the
 * next record links back to the one it replaces.
 */
export function switchLastKnownGood(input: {
  previous: readonly LastKnownGood[];
  next: LastKnownGood;
  now?: string;
}): { previous: LastKnownGood[]; next: LastKnownGood } {
  const replaced = input.previous
    .filter((record) => record.status === "active")
    .map(
      (record): LastKnownGood => ({
        ...record,
        status: "superseded",
        supersededBy: input.next.lkgId,
      }),
    );

  const next: LastKnownGood = {
    ...input.next,
    status: "active",
    supersedes: replaced[0]?.lkgId ?? input.next.supersedes,
  };

  return { previous: replaced, next };
}

/**
 * Picks the pin to serve externally. A pin that already contains the
 * requested artifact wins; otherwise the most recently verified pin is used.
 */
export function selectLastKnownGood(
  records: readonly LastKnownGood[],
  artifactId?: string,
): LastKnownGood | null {
  if (records.length === 0) {
    return null;
  }
  if (artifactId) {
    const exact = records.find((record) =>
      record.artifactRefs.some((ref) => ref.artifactId === artifactId),
    );
    if (exact) {
      return exact;
    }
  }
  const sorted = [...records].sort(
    (left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt),
  );
  return sorted[0] ?? records[0] ?? null;
}

export function selectLkgArtifactRef(
  lkg: LastKnownGood,
  artifactId?: string,
): LkgArtifactRef {
  if (artifactId) {
    const exact = lkg.artifactRefs.find((ref) => ref.artifactId === artifactId);
    if (exact) {
      return exact;
    }
  }
  const first = lkg.artifactRefs[0];
  if (!first) {
    throw new LkgContractError(
      "invalid_refs",
      `last-known-good ${lkg.lkgId} has no artifact refs`,
    );
  }
  return first;
}

/** `local_file` stays inside the workspace; every other channel is external. */
export function isExternalDeliveryChannel(channel: string): boolean {
  return channel !== "local_file";
}

export interface ExternalDeliveryDecision {
  ok: boolean;
  external: boolean;
  source: "artifact" | "lkg";
  artifactId: string;
  version: number;
  verifiedAt: string | null;
  verifier: string | null;
  lkgId: string | null;
  modeId: string | null;
  reasons: string[];
}

/**
 * Routes external delivery through the degradation state machine: a degraded
 * workspace serves its verified LKG, and a missing or expired LKG blocks the
 * external output instead of leaking unverified content.
 */
export function resolveExternalDelivery(input: {
  artifactId: string;
  version?: number;
  channel: string;
  mode: DegradedMode | null;
  lkg?: LastKnownGood | null;
  now?: string;
}): ExternalDeliveryDecision {
  const now = input.now ?? new Date().toISOString();
  const external = isExternalDeliveryChannel(input.channel);
  const mode = input.mode?.status === "active" ? input.mode : null;
  const base: ExternalDeliveryDecision = {
    ok: true,
    external,
    source: "artifact",
    artifactId: input.artifactId,
    version: input.version ?? 1,
    verifiedAt: null,
    verifier: null,
    lkgId: null,
    modeId: mode?.modeId ?? null,
    reasons: [],
  };

  if (!external || !mode) {
    return base;
  }

  if (isExecutionBlocked(mode)) {
    return {
      ...base,
      ok: false,
      reasons: ["read-only mode blocks delivery"],
    };
  }

  const lkg = input.lkg ?? null;
  if (!lkg) {
    return {
      ...base,
      ok: false,
      modeId: mode.modeId,
      reasons: [
        "degraded delivery requires a verified last-known-good; none is registered",
      ],
    };
  }

  const verification = lkgVerification(lkg, now);
  if (verification.state !== "verified") {
    return {
      ...base,
      ok: false,
      lkgId: lkg.lkgId,
      verifiedAt: lkg.verifiedAt,
      verifier: lkg.verifier,
      modeId: mode.modeId,
      reasons: [
        `last-known-good ${lkg.lkgId} is internal-only: ${verification.reason}`,
      ],
    };
  }

  const ref = selectLkgArtifactRef(lkg, input.artifactId);
  return {
    ...base,
    source: "lkg",
    artifactId: ref.artifactId,
    version: ref.version,
    verifiedAt: lkg.verifiedAt,
    verifier: lkg.verifier,
    lkgId: lkg.lkgId,
    modeId: mode.modeId,
  };
}
