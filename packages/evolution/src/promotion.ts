import type { RunMode } from "@kit/core";

/**
 * Promotion gate for evolution variants (70 §3.1, §3.3 invariants 5/7, §3.6,
 * 50 §3.5).
 *
 * The gate is pure: it takes the variant kind, workspace ownership and the
 * approvals recorded against the promotion subject and decides whether a write
 * may touch a target pack. Persisting approvals and decisions stays with the
 * store (`approvals` via the unified inbox) and `evolution_decisions`, so this
 * module never forks a second approval system.
 */

export const VARIANT_KINDS = ["context", "tool", "architecture"] as const;

export type VariantKind = (typeof VARIANT_KINDS)[number];

export function isVariantKind(value: unknown): value is VariantKind {
  return (
    typeof value === "string" &&
    (VARIANT_KINDS as readonly string[]).includes(value)
  );
}

const ARCHITECTURE_PATHS = [/^team\.ya?ml$/i, /^workflows\//i, /^roles\//i];
const TOOL_PATHS = [/^skills\//i, /^tools\//i];

/**
 * Role/team structural changes (team.yaml, workflow or role definitions) are
 * architecture variants and go through the three-party gate; skill and tool
 * files are tool variants; everything else is a context variant.
 */
export function inferVariantKind(changedFiles: readonly string[]): VariantKind {
  const files = changedFiles.map((file) => file.split("\\").join("/"));
  const matches = (patterns: RegExp[]): boolean =>
    files.some((file) => patterns.some((pattern) => pattern.test(file)));
  if (matches(ARCHITECTURE_PATHS)) {
    return "architecture";
  }
  if (matches(TOOL_PATHS)) {
    return "tool";
  }
  return "context";
}

/**
 * Effective kind for gating. Role/team structural changes always escalate to
 * `architecture` even when a variant is mislabelled, so the three-party gate
 * cannot be skipped by a stale `kind` field.
 */
export function resolveVariantKind(input: {
  kind?: VariantKind;
  changedFiles?: readonly string[];
}): VariantKind {
  const inferred = inferVariantKind(input.changedFiles ?? []);
  if (inferred === "architecture") {
    return "architecture";
  }
  return input.kind ?? inferred;
}

export const PROMOTION_ROLES = [
  "operator",
  "quality",
  "security",
  "architecture",
] as const;

export type PromotionRole = (typeof PROMOTION_ROLES)[number];

export function isPromotionRole(value: unknown): value is PromotionRole {
  return (
    typeof value === "string" &&
    (PROMOTION_ROLES as readonly string[]).includes(value)
  );
}

/**
 * Roles that must approve before a promotion. Architecture is three-party
 * (operator + security + architecture). The 70 §3.1 second tier for context
 * and tool variants (operator + quality) is intentionally not hard-failed by
 * this issue: `evaluatePromotionGate` reports it but only enforces the tiers
 * listed here.
 */
export const REQUIRED_PROMOTION_ROLES: Readonly<
  Record<VariantKind, readonly PromotionRole[]>
> = Object.freeze({
  context: Object.freeze([]),
  tool: Object.freeze([]),
  architecture: Object.freeze([
    "operator",
    "security",
    "architecture",
  ] as const),
});

export function requiredPromotionRoles(
  kind: VariantKind,
): readonly PromotionRole[] {
  return REQUIRED_PROMOTION_ROLES[kind];
}

export type PromotionApprovalStatus =
  | "approved"
  | "rejected"
  | "queued"
  | "expired";

export interface PromotionApproval {
  approvalId: string;
  role: PromotionRole;
  status: PromotionApprovalStatus;
  /** Approvals are workspace-scoped; a foreign approval never counts. */
  workspaceId?: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
}

export interface WorkspaceExemption {
  exemptionId: string;
  variantId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  reason: string;
  approvedBy: string;
  approvedAt: string;
}

/**
 * Evidence that an architecture variant was exercised outside LIVE with no
 * real side effects (70 §3.1/§3.3). `realSideEffects` is the count observed
 * during validation and must be 0.
 */
export interface ArchitectureValidation {
  mode: RunMode;
  realSideEffects: number;
  validationRef?: string;
  validatedAt?: string;
}

export interface PromotionGateInput {
  kind: VariantKind;
  variantId: string;
  /** Workspace that owns the variant. */
  variantWorkspaceId: string;
  /** Workspace that owns the target pack. */
  targetWorkspaceId: string;
  approvals?: readonly PromotionApproval[];
  exemption?: WorkspaceExemption | null;
  validation?: ArchitectureValidation | null;
}

export interface PromotionGateDecision {
  allowed: boolean;
  kind: VariantKind;
  variantWorkspaceId: string;
  targetWorkspaceId: string;
  requiredRoles: readonly PromotionRole[];
  approvedRoles: PromotionRole[];
  missingRoles: PromotionRole[];
  rejectedRoles: PromotionRole[];
  crossWorkspace: boolean;
  exempted: boolean;
  exemptionId: string | null;
  /** Blocking conditions; empty means the gate allows the promotion. */
  reasons: string[];
  /** Informational notes (applied exemption, ignored foreign approvals). */
  notes: string[];
}

export type PromotionGateFailureCode =
  | "missing_approval"
  | "rejected_approval"
  | "cross_workspace"
  | "missing_validation"
  | "live_validation"
  | "side_effects";

export class PromotionGateError extends Error {
  constructor(
    readonly code: PromotionGateFailureCode,
    message: string,
    readonly decision?: PromotionGateDecision,
  ) {
    super(message);
    this.name = "PromotionGateError";
  }
}

function exemptionCovers(
  exemption: WorkspaceExemption | null | undefined,
  input: PromotionGateInput,
): boolean {
  return (
    exemption !== null &&
    exemption !== undefined &&
    exemption.exemptionId.trim().length > 0 &&
    exemption.approvedBy.trim().length > 0 &&
    exemption.variantId === input.variantId &&
    exemption.fromWorkspaceId === input.variantWorkspaceId &&
    exemption.toWorkspaceId === input.targetWorkspaceId
  );
}

/**
 * Evaluates every gate at once and returns the full decision, so callers can
 * render missing roles rather than parse the first thrown error.
 */
export function evaluatePromotionGate(
  input: PromotionGateInput,
): PromotionGateDecision {
  const required = requiredPromotionRoles(input.kind);
  const reasons: string[] = [];
  const notes: string[] = [];
  const approvedRoles: PromotionRole[] = [];
  const rejectedRoles: PromotionRole[] = [];
  const approvalById = new Map<string, PromotionApproval>();
  for (const approval of input.approvals ?? []) {
    if (
      approval.workspaceId !== undefined &&
      approval.workspaceId !== input.targetWorkspaceId
    ) {
      notes.push(
        `approval ${approval.approvalId} belongs to workspace ${approval.workspaceId}, not ${input.targetWorkspaceId}`,
      );
      continue;
    }
    if (!isPromotionRole(approval.role)) {
      continue;
    }
    approvalById.set(approval.approvalId, approval);
  }
  for (const role of required) {
    const matching = [...approvalById.values()].filter(
      (approval) => approval.role === role,
    );
    if (matching.some((approval) => approval.status === "approved")) {
      approvedRoles.push(role);
      continue;
    }
    if (matching.some((approval) => approval.status === "rejected")) {
      rejectedRoles.push(role);
    }
  }
  const missingRoles = required.filter((role) => !approvedRoles.includes(role));
  if (missingRoles.length > 0) {
    reasons.push(
      `${input.kind} promotion needs ${required.join(" + ")} approvals; missing ${missingRoles.join(", ")}`,
    );
  }
  if (rejectedRoles.length > 0) {
    reasons.push(
      `${input.kind} promotion was rejected by ${rejectedRoles.join(", ")}`,
    );
  }

  const crossWorkspace = input.variantWorkspaceId !== input.targetWorkspaceId;
  const exemption = input.exemption ?? null;
  const exempted = crossWorkspace && exemptionCovers(exemption, input);
  if (crossWorkspace && !exempted) {
    reasons.push(
      `variant ${input.variantId} belongs to workspace ${input.variantWorkspaceId}; cross-workspace promotion into ${input.targetWorkspaceId} needs an explicit exemption`,
    );
  }
  if (exempted && exemption) {
    notes.push(
      `exemption ${exemption.exemptionId} applied for ${exemption.fromWorkspaceId} -> ${exemption.toWorkspaceId} by ${exemption.approvedBy}`,
    );
  }

  if (input.kind === "architecture") {
    const validation = input.validation ?? null;
    if (!validation) {
      reasons.push(
        "architecture variants must be validated outside LIVE before promotion",
      );
    } else if (validation.mode === "LIVE") {
      reasons.push(
        "architecture validation ran in LIVE; re-validate in SHADOW or DRY_RUN",
      );
    } else if (validation.realSideEffects > 0) {
      reasons.push(
        `architecture validation observed ${validation.realSideEffects} real side effects; expected 0`,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    kind: input.kind,
    variantWorkspaceId: input.variantWorkspaceId,
    targetWorkspaceId: input.targetWorkspaceId,
    requiredRoles: required,
    approvedRoles,
    missingRoles,
    rejectedRoles,
    crossWorkspace,
    exempted,
    exemptionId: exempted && exemption ? exemption.exemptionId : null,
    reasons,
    notes,
  };
}

/** Throws a {@link PromotionGateError} naming the first blocking condition. */
export function assertPromotionGate(
  input: PromotionGateInput,
): PromotionGateDecision {
  const decision = evaluatePromotionGate(input);
  if (decision.allowed) {
    return decision;
  }

  let code: PromotionGateFailureCode = "missing_approval";
  if (decision.crossWorkspace && !decision.exempted) {
    code = "cross_workspace";
  } else if (decision.rejectedRoles.length > 0) {
    code = "rejected_approval";
  } else if (decision.missingRoles.length > 0) {
    code = "missing_approval";
  } else if (input.kind === "architecture" && !input.validation) {
    code = "missing_validation";
  } else if (input.validation?.mode === "LIVE") {
    code = "live_validation";
  } else if ((input.validation?.realSideEffects ?? 0) > 0) {
    code = "side_effects";
  }
  throw new PromotionGateError(code, decision.reasons.join("; "), decision);
}
