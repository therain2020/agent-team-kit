/**
 * Single source of truth for iteration risk classification and auto-apply
 * boundaries.
 *
 * Iterate may change ordinary code, tests, docs and i18n copy on its own once
 * verification passes. It must not rewrite its own substrate:
 *
 * - `packs/<pack>/agents/**`, `packs/<pack>/skills/**` and `skills/**` define
 *   what agents are allowed to do. Iterate can only propose these changes;
 *   promotion belongs to the evolution plane (freeze → evaluate → canary).
 * - `packs/<pack>/workflows/**`, `team.yaml`, `autopilot.yaml`, `policies.yaml`
 *   and `iteration.yaml` are orchestration definitions: at least high risk and
 *   always behind explicit approval.
 *
 * Every consumer (`classifyRisk`, `apply`, autopilot, CLI) imports the same
 * rules from here so a new protected path only needs one edit.
 */

export type IterationRisk = "low" | "medium" | "high";
export type IterationApplyMode = "none" | "low" | "low-medium";

export type SubstrateProtection =
  | "none"
  | "forbidden-path"
  | "instructions"
  | "orchestration";

export type ChangedFileCategory =
  | "forbidden"
  | "instructions"
  | "orchestration"
  | "core"
  | "server"
  | "low"
  | "default";

export interface ChangedFileVerdict {
  path: string;
  category: ChangedFileCategory;
  risk: IterationRisk;
  forbidden: boolean;
  requiresApproval: boolean;
  reason: string;
}

export interface ChangedFilesAssessment {
  risk: IterationRisk;
  forbidden: boolean;
  requiresApproval: boolean;
  protection: SubstrateProtection;
  reasons: string[];
  /** Substrate files that triggered protection, empty for ordinary changes. */
  protectedPaths: string[];
  files: ChangedFileVerdict[];
}

/** Files that must never leave the sandbox, regardless of risk mode. */
const FORBIDDEN_PATH =
  /^(\.git|node_modules|\.env|\.tmp|variants|\.backup)(\/|$)/;

/** Agent instructions and skills: proposal-only, never auto-applied. */
const INSTRUCTION_SUBSTRATE = /^(packs\/[^/]+\/(agents|skills)\/|skills\/)/;

/** Orchestration definitions: at least high risk, always require approval. */
const ORCHESTRATION_SUBSTRATE =
  /^(packs\/[^/]+\/(workflows\/|(team|autopilot|policies|iteration)\.ya?ml$))/;

const CORE_PATH =
  /^(apps\/runtime\/|packages\/(core|workflow|store|queue|model|manager|evolution|telemetry|testing|source|autopilot)\/|deploy\/|\.github\/|bun\.lock$|package\.json$)/;

const SERVER_PATH =
  /^(apps\/cli\/|apps\/gateway\/|packages\/(pack|tools|coder)\/|apps\/web\/app\/api\/|apps\/web\/lib\/)/;

const LOW_RISK_PATH =
  /^(docs\/|.*README\.md$|.*CHANGELOG\.md$|apps\/web\/messages\/|.*\.test\.ts$|.*\/test\/)/;

const RISK_RANK: Record<IterationRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function maxRisk(a: IterationRisk, b: IterationRisk): IterationRisk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export function riskRank(risk: IterationRisk): number {
  return RISK_RANK[risk];
}

export function normalizeChangedPath(file: string): string {
  return file.replace(/\\/g, "/");
}

export function classifyChangedFile(file: string): ChangedFileVerdict {
  const path = normalizeChangedPath(file);
  if (
    path.startsWith("/") ||
    path.includes("..") ||
    FORBIDDEN_PATH.test(path)
  ) {
    return {
      path,
      category: "forbidden",
      risk: "high",
      forbidden: true,
      requiresApproval: true,
      reason: `forbidden path: ${path}`,
    };
  }
  if (INSTRUCTION_SUBSTRATE.test(path)) {
    return {
      path,
      category: "instructions",
      risk: "high",
      forbidden: true,
      requiresApproval: true,
      reason: `substrate instructions are proposal-only: ${path}`,
    };
  }
  if (ORCHESTRATION_SUBSTRATE.test(path)) {
    return {
      path,
      category: "orchestration",
      risk: "high",
      forbidden: false,
      requiresApproval: true,
      reason: `substrate orchestration requires approval: ${path}`,
    };
  }
  if (CORE_PATH.test(path)) {
    return {
      path,
      category: "core",
      risk: "high",
      forbidden: false,
      requiresApproval: false,
      reason: `core path: ${path}`,
    };
  }
  if (SERVER_PATH.test(path)) {
    return {
      path,
      category: "server",
      risk: "medium",
      forbidden: false,
      requiresApproval: false,
      reason: `server code: ${path}`,
    };
  }
  if (LOW_RISK_PATH.test(path)) {
    return {
      path,
      category: "low",
      risk: "low",
      forbidden: false,
      requiresApproval: false,
      reason: `low-risk path: ${path}`,
    };
  }
  return {
    path,
    category: "default",
    risk: "medium",
    forbidden: false,
    requiresApproval: false,
    reason: `default medium: ${path}`,
  };
}

export function assessChangedFiles(files: string[]): ChangedFilesAssessment {
  let risk: IterationRisk = "low";
  let forbidden = false;
  let requiresApproval = false;
  let protection: SubstrateProtection = "none";
  const reasons: string[] = [];
  const protectedPaths: string[] = [];
  const verdicts: ChangedFileVerdict[] = [];

  for (const file of files) {
    const verdict = classifyChangedFile(file);
    verdicts.push(verdict);
    risk = maxRisk(risk, verdict.risk);
    reasons.push(verdict.reason);
    if (verdict.category === "instructions") {
      protection = "instructions";
      forbidden = true;
      requiresApproval = true;
      protectedPaths.push(verdict.path);
    } else if (verdict.category === "orchestration") {
      if (protection === "none") {
        protection = "orchestration";
      }
      requiresApproval = true;
      protectedPaths.push(verdict.path);
    } else if (verdict.forbidden) {
      if (protection === "none") {
        protection = "forbidden-path";
      }
      forbidden = true;
      requiresApproval = true;
      protectedPaths.push(verdict.path);
    }
  }

  return {
    risk,
    forbidden,
    requiresApproval,
    protection,
    reasons,
    protectedPaths,
    files: verdicts,
  };
}

export interface ClassifiedRisk {
  risk: IterationRisk;
  reasons: string[];
  forbidden: boolean;
  requiresApproval: boolean;
  protection: SubstrateProtection;
  protectedPaths: string[];
}

export function classifyIterationRisk(
  files: string[],
  plannedRisk: IterationRisk,
  ceiling: IterationRisk,
): ClassifiedRisk {
  const assessment = assessChangedFiles(files);
  let risk = maxRisk(plannedRisk, assessment.risk);
  const reasons = [...assessment.reasons];
  if (riskRank(risk) > riskRank(ceiling)) {
    reasons.push(`exceeds domain risk ceiling ${ceiling}`);
    risk = "high";
  }
  return {
    risk,
    reasons,
    forbidden: assessment.forbidden,
    requiresApproval: assessment.requiresApproval,
    protection: assessment.protection,
    protectedPaths: assessment.protectedPaths,
  };
}

/** Whether `mode` allows committing a change at this risk level. */
export function allowedByApplyMode(
  risk: IterationRisk,
  mode: IterationApplyMode,
): boolean {
  if (mode === "none" || risk === "high") {
    return false;
  }
  if (risk === "low") {
    return true;
  }
  return mode === "low-medium";
}

/** LIVE iterations honor the requested mode; dry runs never apply. */
export function resolveIterationApplyMode(
  runMode: "DRY_RUN" | "LIVE",
  applyMode: IterationApplyMode,
): IterationApplyMode {
  return runMode === "LIVE" ? applyMode : "none";
}

export interface IterationApplyPolicyInput {
  runMode: "DRY_RUN" | "LIVE";
  applyMode: IterationApplyMode;
  risk: IterationRisk;
  changedFiles: string[];
}

export interface IterationApplyPolicyDecision {
  action: "apply" | "skip" | "block";
  reason: string;
  effectiveRisk: IterationRisk;
  substrate: ChangedFilesAssessment;
}

/**
 * Resolve what iterate may do with a verified change. `block` means the change
 * stays a proposal (no commit, no pending manual apply); `skip` means it is
 * parked for the approval / pending-change flow.
 */
export function evaluateIterationApply(
  input: IterationApplyPolicyInput,
): IterationApplyPolicyDecision {
  const substrate = assessChangedFiles(input.changedFiles);
  const effectiveRisk = maxRisk(input.risk, substrate.risk);

  if (substrate.protection === "instructions") {
    return {
      action: "block",
      reason: `substrate protected: agent/skill instructions cannot be auto-applied (${substrate.protectedPaths.join(", ")})`,
      effectiveRisk,
      substrate,
    };
  }
  if (substrate.forbidden) {
    return {
      action: "block",
      reason: `forbidden path detected (${substrate.protectedPaths.join(", ")})`,
      effectiveRisk,
      substrate,
    };
  }
  if (input.runMode !== "LIVE") {
    return {
      action: "skip",
      reason: "dry run: apply disabled",
      effectiveRisk,
      substrate,
    };
  }
  if (!allowedByApplyMode(effectiveRisk, input.applyMode)) {
    return {
      action: "skip",
      reason: `risk ${effectiveRisk} is not auto-applied by mode ${input.applyMode}`,
      effectiveRisk,
      substrate,
    };
  }
  return {
    action: "apply",
    reason: `risk ${effectiveRisk} allowed by mode ${input.applyMode}`,
    effectiveRisk,
    substrate,
  };
}
