import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ChangedFilesAssessment, assessChangedFiles } from "@kit/core";
import type { SnapshotVerification } from "./snapshot";

/**
 * Security invariant probes for the evolution plane.
 *
 * Every invariant has a stable id so a failed assertion names the rule it
 * protects (70 §3.3/§5, 85 §3.6, 50 §3.8/§3.9):
 *
 * - SEC-INV-01: an agent may never write the recovery kernel, LKG or audit sink.
 * - SEC-INV-02: a change that disables audit or approval is blocked outright.
 * - SEC-INV-03: eval snapshots live only inside the external kit home.
 * - SEC-INV-04: a frozen eval snapshot fails closed when tampered with.
 *
 * The probes are pure and injectable (`kitHome`, `repoRoot`, temp roots), so
 * tests are hermetic and never touch the operator's real `KIT_HOME`.
 */

export const SECURITY_INVARIANTS = {
  "SEC-INV-01":
    "agent writes to the recovery kernel, LKG or audit sink are rejected",
  "SEC-INV-02": "changes that disable audit or approval are blocked",
  "SEC-INV-03": "eval snapshots live only in the external kit home",
  "SEC-INV-04": "frozen eval snapshots fail closed when tampered",
} as const;

export type SecurityInvariantId = keyof typeof SECURITY_INVARIANTS;

export class SecurityInvariantError extends Error {
  readonly code = "security-invariant" as const;
  readonly invariant: SecurityInvariantId;
  readonly target?: string;

  constructor(
    invariant: SecurityInvariantId,
    message: string,
    target?: string,
  ) {
    super(`${invariant}: ${message}`);
    this.name = "SecurityInvariantError";
    this.invariant = invariant;
    if (target !== undefined) {
      this.target = target;
    }
  }
}

export function isSecurityInvariantError(
  value: unknown,
): value is SecurityInvariantError {
  return value instanceof SecurityInvariantError;
}

export interface RecoverySurface {
  kitHome: string;
  /** Recovery kernel scripts (`<home>/bin/kitd.ps1`, `install-kitd.ps1`). */
  kernelDir: string;
  /** Append-only audit sink (`<home>/audit/kitd.jsonl`). */
  auditDir: string;
  /** LKG tag/bundle state (`<home>/state/lkg*.txt`). */
  stateDir: string;
  /** Kill switch file (`<home>/KILL`). */
  killFile: string;
  /** External frozen eval snapshots (`<home>/cycles`). */
  cyclesRoot: string;
}

export type ProtectedTargetKind =
  | "recovery-kernel"
  | "audit-sink"
  | "lkg"
  | "kill-switch"
  | "eval-snapshot"
  | "unprotected";

export interface ProtectedWriteVerdict {
  target: string;
  allowed: boolean;
  kind: ProtectedTargetKind;
  invariant: SecurityInvariantId | null;
  reason: string;
  surface: RecoverySurface;
}

/** Resolve the external kit home. Injectable so tests never read the real one. */
export function resolveKitHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.KIT_HOME?.trim();
  const home =
    configured && configured.length > 0
      ? configured
      : path.join(os.homedir(), ".agent-team-kit");
  return path.resolve(home);
}

export function describeRecoverySurface(
  kitHome: string = resolveKitHome(),
): RecoverySurface {
  const home = path.resolve(kitHome);
  return {
    kitHome: home,
    kernelDir: path.join(home, "bin"),
    auditDir: path.join(home, "audit"),
    stateDir: path.join(home, "state"),
    killFile: path.join(home, "KILL"),
    cyclesRoot: path.join(home, "cycles"),
  };
}

/** Compare paths the way the host filesystem does (case-insensitive Windows). */
function fold(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `child` resolves to `parent` or somewhere below it. */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(fold(parent), fold(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * True for paths that leave the repository entirely: POSIX absolute paths,
 * Windows drive letters, UNC shares or `..` traversal. Agent patches must stay
 * repo-relative, so any such path is an attempt to reach outside the sandbox.
 */
export function isExternalAbsolutePath(file: string): boolean {
  if (path.isAbsolute(file)) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(file)) {
    return true;
  }
  if (file.startsWith("\\\\") || file.startsWith("//")) {
    return true;
  }
  return file.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * Classify a write target against the recovery surface. Used for runtime
 * write probes and for agent-proposed absolute paths.
 */
export function classifyProtectedWrite(
  target: string,
  options: { kitHome?: string } = {},
): ProtectedWriteVerdict {
  const surface = describeRecoverySurface(options.kitHome);
  const resolved = path.resolve(target);
  const verdict = (
    kind: ProtectedTargetKind,
    invariant: SecurityInvariantId | null,
    reason: string,
  ): ProtectedWriteVerdict => ({
    target: resolved,
    allowed: invariant === null,
    kind,
    invariant,
    reason,
    surface,
  });

  if (isPathInside(surface.kernelDir, resolved)) {
    return verdict(
      "recovery-kernel",
      "SEC-INV-01",
      "recovery kernel lives outside the agent write surface",
    );
  }
  if (isPathInside(surface.auditDir, resolved)) {
    return verdict(
      "audit-sink",
      "SEC-INV-01",
      "the audit sink is append-only and lives outside the agent write surface",
    );
  }
  if (isPathInside(surface.stateDir, resolved)) {
    return verdict(
      "lkg",
      "SEC-INV-01",
      "LKG state and bundles are owned by the recovery kernel",
    );
  }
  if (fold(resolved) === fold(surface.killFile)) {
    return verdict(
      "kill-switch",
      "SEC-INV-01",
      "the kill switch is operated by the recovery kernel only",
    );
  }
  if (isPathInside(surface.cyclesRoot, resolved)) {
    return verdict(
      "eval-snapshot",
      "SEC-INV-03",
      "frozen eval snapshots are written by the cycle freezer only",
    );
  }
  return verdict("unprotected", null, "outside the protected recovery surface");
}

/** Throw SEC-INV-01 (or SEC-INV-03 for snapshot roots) when a write is denied. */
export function assertAgentWriteAllowed(
  target: string,
  options: { kitHome?: string } = {},
): ProtectedWriteVerdict {
  const verdict = classifyProtectedWrite(target, options);
  if (!verdict.allowed && verdict.invariant) {
    throw new SecurityInvariantError(
      verdict.invariant,
      `${verdict.kind} is not agent-writable: ${verdict.reason}`,
      verdict.target,
    );
  }
  return verdict;
}

/**
 * Frozen eval snapshots must stay inside the external kit home and outside the
 * repository. `createEvalSnapshot` calls this when a `kitHome` is supplied.
 */
export function assertSnapshotRootAllowed(input: {
  cyclesRoot: string;
  kitHome: string;
  repoRoot?: string;
}): { cyclesRoot: string; kitHome: string } {
  const cyclesRoot = path.resolve(input.cyclesRoot);
  const kitHome = path.resolve(input.kitHome);
  if (input.repoRoot && isPathInside(input.repoRoot, cyclesRoot)) {
    throw new SecurityInvariantError(
      "SEC-INV-03",
      `eval snapshots must live outside the repository (${cyclesRoot})`,
      cyclesRoot,
    );
  }
  if (!isPathInside(kitHome, cyclesRoot)) {
    throw new SecurityInvariantError(
      "SEC-INV-03",
      `eval snapshots must live inside the kit home ${kitHome} (got ${cyclesRoot})`,
      cyclesRoot,
    );
  }
  return { cyclesRoot, kitHome };
}

export interface ControlPlaneFinding {
  rule: string;
  line: number;
  excerpt: string;
}

interface DisableRule {
  id: string;
  pattern: RegExp;
}

/** Patterns that turn off audit or approval. Conservative on purpose. */
const DISABLE_RULES: DisableRule[] = [
  { id: "audit-disabled", pattern: /\bdisableAudit\b/ },
  {
    id: "audit-disabled-config",
    pattern:
      /\baudit(?:Enabled|_enabled)?\s*[:=]\s*(?:false|0\b|["'](?:off|none)["'])/,
  },
  {
    id: "audit-flag",
    pattern:
      /--no-audit\b|\bKIT_[A-Z0-9_]*AUDIT[A-Z0-9_]*\s*[:=]\s*["']?(?:0|false|off)\b/,
  },
  { id: "approval-skipped", pattern: /\b(?:skip|bypass|disable)Approvals?\b/ },
  {
    id: "approval-disabled-config",
    pattern:
      /\b(?:requireApproval|requiresApproval|approvalsEnabled)\s*[:=]\s*false\b/,
  },
  { id: "approval-flag", pattern: /--no-approval\b/ },
];

const PROTECTED_AUDIT_FILE =
  /^(?:.*\/)?(?:audit|approval|approvals)(?:[-_.\/]|$)[^/]*\.(?:ts|tsx|js|sql|jsonl)$/i;

/** Find lines that would disable audit or approval in proposed content. */
export function detectControlPlaneDisable(
  content: string,
): ControlPlaneFinding[] {
  const findings: ControlPlaneFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of DISABLE_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          line: index + 1,
          excerpt: line.trim().slice(0, 120),
        });
        break;
      }
    }
  }
  return findings;
}

/** Deleting audit/approval implementation or tests disables the control plane. */
export function detectControlPlaneDeletion(files: string[]): string[] {
  return files.filter((file) =>
    PROTECTED_AUDIT_FILE.test(file.split(/[\\/]/).join("/")),
  );
}

export interface PatchSecurityInput {
  /** Agent-proposed changed repository-relative paths. */
  files: string[];
  /** Proposed new contents, keyed by path (optional). */
  contents?: Record<string, string>;
  /** Files the patch deletes (optional). */
  deletedFiles?: string[];
  kitHome?: string;
}

export interface PatchSecurityDecision {
  action: "allow" | "block";
  invariant: SecurityInvariantId | null;
  reasons: string[];
  protectedTargets: string[];
  findings: ControlPlaneFinding[];
  assessment: ChangedFilesAssessment;
}

/**
 * Evaluate an agent-proposed patch against the security invariants. Returns
 * `block` with the invariant id that the change violates, or `allow` when the
 * patch stays inside the repository and leaves audit/approval intact.
 */
export function evaluatePatchSecurity(
  input: PatchSecurityInput,
): PatchSecurityDecision {
  const surface = describeRecoverySurface(input.kitHome);
  const assessment = assessChangedFiles(input.files);
  const reasons: string[] = [];
  const protectedTargets: string[] = [];
  let invariant: SecurityInvariantId | null = null;

  for (const file of input.files) {
    if (isExternalAbsolutePath(file)) {
      const verdict = classifyProtectedWrite(file, {
        kitHome: surface.kitHome,
      });
      const target = verdict.allowed ? file : verdict.target;
      if (!protectedTargets.includes(target)) {
        protectedTargets.push(target);
      }
      reasons.push(
        `agent patches must be repository-relative; refusing path outside the sandbox: ${file}`,
      );
      invariant ??= verdict.invariant ?? "SEC-INV-01";
    }
  }

  const deletedProtected = detectControlPlaneDeletion(input.deletedFiles ?? []);
  for (const file of deletedProtected) {
    protectedTargets.push(file);
    reasons.push(`deleting audit/approval surface is forbidden: ${file}`);
    invariant ??= "SEC-INV-02";
  }

  const findings: ControlPlaneFinding[] = [];
  for (const [file, content] of Object.entries(input.contents ?? {})) {
    for (const finding of detectControlPlaneDisable(content)) {
      findings.push(finding);
      reasons.push(
        `${file}:${finding.line} disables the control plane (${finding.rule})`,
      );
      invariant ??= "SEC-INV-02";
    }
  }

  return {
    action: invariant === null ? "allow" : "block",
    invariant,
    reasons,
    protectedTargets,
    findings,
    assessment,
  };
}

/**
 * Assert a snapshot verification result. Fails closed: any mismatch (changed,
 * added, removed file or manifest hash) raises SEC-INV-04.
 */
export function assertFrozenSnapshotIntact(
  verification: SnapshotVerification,
  dir: string,
): void {
  if (!verification.ok) {
    throw new SecurityInvariantError(
      "SEC-INV-04",
      `frozen eval snapshot failed verification (${dir}): ${verification.mismatches.join(", ") || "unknown mismatch"}`,
      dir,
    );
  }
}

export function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

/**
 * Cross-platform write probe. On Windows the read-only attribute denies the
 * open; on POSIX a 0444 file denies it for non-root users. The hash check in
 * `verifyEvalSnapshot` remains the hard guard on either platform.
 */
export async function isWritable(target: string): Promise<boolean> {
  try {
    const handle = await open(target, "r+");
    await handle.close();
    return true;
  } catch {
    try {
      await access(target, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** True when the filesystem reports the write bit, i.e. the file is frozen. */
export async function isModeReadOnly(target: string): Promise<boolean> {
  const info = await stat(target);
  return (info.mode & 0o200) === 0;
}

/** Whether the caller can bypass permission checks (root ignores POSIX modes). */
export function runsAsRoot(): boolean {
  return process.getuid?.() === 0;
}
