import type { RunMode } from "./event";

/**
 * Credential scope a run mode is allowed to use (20 §2.4). Only LIVE may use
 * production credentials; every other mode is sandbox-only. This is a contract
 * helper, not an enforcement point by itself: gateways call `runModePolicy`
 * before touching credentials, the network or an external system.
 */
export type RunModeCredentialScope = "production" | "sandbox";

/** Outbound network posture for a run mode. */
export type RunModeOutboundPolicy = "allowlist" | "deny";

/**
 * How side-effecting tools may behave:
 * - `execute`: the real side effect is performed (LIVE only)
 * - `recorded`: replay injects a recorded result instead of executing
 * - `stub`: a deterministic stub stands in for the tool
 * - `none`: the tool must not run at all
 */
export type RunModeSideEffectPolicy = "execute" | "recorded" | "stub" | "none";

/** Artifact label written into the Manifest / UI for non-LIVE runs. */
export type RunModeArtifactLabel =
  | "official"
  | "shadow"
  | "replay"
  | "fork"
  | "backfill"
  | "dry_run";

export interface RunModePolicy {
  readonly mode: RunMode;
  readonly credentialScope: RunModeCredentialScope;
  readonly outbound: RunModeOutboundPolicy;
  readonly sideEffects: RunModeSideEffectPolicy;
  /** `official` artifacts are the default downstream result (30 §3.3). */
  readonly artifactVisibility: "official" | "internal";
  readonly artifactLabel: RunModeArtifactLabel;
  /** Non-LIVE artifacts need a publish decision + approval to become official. */
  readonly promotionRequiresApproval: boolean;
}

/**
 * The run-mode / side-effect matrix from 20 §2.4, encoded once so every
 * gateway (delivery, tools, effect keys) reads the same contract. Adding a
 * mode without a row is a type error at compile time.
 */
export const RUN_MODE_POLICIES: Readonly<Record<RunMode, RunModePolicy>> =
  Object.freeze({
    LIVE: Object.freeze({
      mode: "LIVE",
      credentialScope: "production",
      outbound: "allowlist",
      sideEffects: "execute",
      artifactVisibility: "official",
      artifactLabel: "official",
      promotionRequiresApproval: false,
    }),
    SHADOW: Object.freeze({
      mode: "SHADOW",
      credentialScope: "sandbox",
      outbound: "deny",
      sideEffects: "stub",
      artifactVisibility: "internal",
      artifactLabel: "shadow",
      promotionRequiresApproval: true,
    }),
    REPLAY: Object.freeze({
      mode: "REPLAY",
      credentialScope: "sandbox",
      outbound: "deny",
      sideEffects: "recorded",
      artifactVisibility: "internal",
      artifactLabel: "replay",
      promotionRequiresApproval: true,
    }),
    FORK: Object.freeze({
      mode: "FORK",
      credentialScope: "sandbox",
      outbound: "deny",
      sideEffects: "stub",
      artifactVisibility: "internal",
      artifactLabel: "fork",
      promotionRequiresApproval: true,
    }),
    BACKFILL: Object.freeze({
      mode: "BACKFILL",
      credentialScope: "sandbox",
      outbound: "deny",
      sideEffects: "stub",
      artifactVisibility: "internal",
      artifactLabel: "backfill",
      promotionRequiresApproval: true,
    }),
    DRY_RUN: Object.freeze({
      mode: "DRY_RUN",
      credentialScope: "sandbox",
      outbound: "deny",
      sideEffects: "none",
      artifactVisibility: "internal",
      artifactLabel: "dry_run",
      promotionRequiresApproval: true,
    }),
  });

/** Env prefix for sandbox credentials. Non-LIVE runs see only these keys. */
export const SANDBOX_CREDENTIAL_PREFIX = "KIT_SANDBOX_";

export type RunModeGuardErrorCode =
  | "unknown_run_mode"
  | "side_effect_refused"
  | "outbound_refused";

export class RunModeGuardError extends Error {
  constructor(
    readonly code: RunModeGuardErrorCode,
    message: string,
    readonly mode?: RunMode,
  ) {
    super(message);
    this.name = "RunModeGuardError";
  }
}

/** Explicit approval that permits one real side effect outside LIVE. */
export interface RunModeEffectApproval {
  /** Effect key from 20 §3.3: tenant:run:stage:action:target. */
  effectKey: string;
  approvalId: string;
  approvedBy: string;
}

export interface RunModeSideEffectRequest {
  runMode: RunMode;
  /** Human-readable action, e.g. `delivery.webhook` or `repo.apply`. */
  action: string;
  effectKey?: string;
  approval?: RunModeEffectApproval;
}

export function runModePolicy(mode: RunMode): RunModePolicy {
  const policy = RUN_MODE_POLICIES[mode];
  if (!policy) {
    throw new RunModeGuardError(
      "unknown_run_mode",
      `unknown run mode: ${String(mode)}`,
    );
  }
  return policy;
}

export function isLiveRunMode(mode: RunMode | null | undefined): boolean {
  return mode === "LIVE";
}

/** Only LIVE executes real side effects without an explicit effect approval. */
export function runModeAllowsRealSideEffect(mode: RunMode): boolean {
  return runModePolicy(mode).sideEffects === "execute";
}

export function runModeAllowsOutbound(mode: RunMode): boolean {
  return runModePolicy(mode).outbound === "allowlist";
}

export function runModeArtifactLabel(mode: RunMode): RunModeArtifactLabel {
  return runModePolicy(mode).artifactLabel;
}

/**
 * Build the effect key from 20 §3.3 so callers cannot invent incompatible
 * keys. Empty segments collapse to `-` to keep the key a stable string.
 */
export function buildEffectKey(parts: {
  tenantId: string;
  runId: string;
  stageId: string;
  action: string;
  target: string;
}): string {
  const clean = (value: string): string => value.trim().replaceAll(":", "-");
  return [
    clean(parts.tenantId),
    clean(parts.runId),
    clean(parts.stageId),
    clean(parts.action),
    clean(parts.target),
  ].join(":");
}

function approvalCovers(
  approval: RunModeEffectApproval | undefined,
  effectKey: string | undefined,
): boolean {
  if (!approval || !effectKey) {
    return false;
  }
  return (
    approval.effectKey === effectKey &&
    approval.approvalId.trim().length > 0 &&
    approval.approvedBy.trim().length > 0
  );
}

/**
 * Decides whether a side effect may execute. LIVE always may; other modes may
 * only when an explicit effect approval covers the exact effect key (50 §3.3).
 * Everything else throws so a caller can never fall through to the real action
 * by accident — the safe path is the stub, not the exception.
 */
export function assertRunModeSideEffectAllowed(
  request: RunModeSideEffectRequest,
): RunModePolicy {
  const policy = runModePolicy(request.runMode);
  if (policy.sideEffects === "execute") {
    return policy;
  }
  if (approvalCovers(request.approval, request.effectKey)) {
    return policy;
  }
  throw new RunModeGuardError(
    "side_effect_refused",
    `${request.runMode} runs cannot execute real side effect "${request.action}" without an approved effect key`,
    request.runMode,
  );
}

/** True when the side effect may execute (LIVE or approved effect key). */
export function runModeSideEffectAllowed(
  request: RunModeSideEffectRequest,
): boolean {
  try {
    assertRunModeSideEffectAllowed(request);
    return true;
  } catch {
    return false;
  }
}

export function assertRunModeOutboundAllowed(
  mode: RunMode,
  target: string,
): RunModePolicy {
  const policy = runModePolicy(mode);
  if (policy.outbound === "allowlist") {
    return policy;
  }
  throw new RunModeGuardError(
    "outbound_refused",
    `${mode} runs cannot make outbound requests (blocked: ${target})`,
    mode,
  );
}

/**
 * Credentials visible to a run. LIVE sees the full environment; every other
 * mode sees only `KIT_SANDBOX_*` entries, so a replay can never hold a
 * production token even when the host process has one.
 */
export function credentialsForRunMode(
  mode: RunMode,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const policy = runModePolicy(mode);
  if (policy.credentialScope === "production") {
    return { ...env };
  }
  const sandbox: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(SANDBOX_CREDENTIAL_PREFIX)) {
      sandbox[key] = value;
    }
  }
  return sandbox;
}
