import { createHash } from "node:crypto";
import path from "node:path";
import { commandOnPath, runProcess } from "@kit/coder";
import type { IterationApplyMode, IterationRisk } from "@kit/core";
import {
  type ApplyPatchResult,
  applyPatchToRepo,
  writeApplyPatch,
} from "@kit/core/git-apply";
import {
  enforcePatchSecurity,
  enforceWriteTargetsAllowed,
  isSecurityInvariantError,
} from "@kit/core/security-invariants";
import type { Store } from "./progress";

export type { IterationApplyMode, IterationRisk };
export { allowedByApplyMode } from "@kit/core";

export interface PublishIterationArtifactInput {
  iterationId: string;
  workspaceId: string;
  stageId: string;
  content: string;
  agentId: string;
  modelId: string;
  tokens?: number;
  costCny?: number;
  runMode: "DRY_RUN" | "LIVE";
}

export async function publishIterationArtifact(
  store: Store,
  input: PublishIterationArtifactInput,
): Promise<string> {
  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(input.content),
    producer: {
      agentId: input.agentId,
      agentVersion: "0.9.0",
      promptHash: hash(input.stageId),
      modelId: input.modelId,
    },
    inputs: [],
    runId: input.iterationId,
    stageId: input.stageId,
    runMode: input.runMode,
    cost: {
      currency: "CNY",
      amount: input.costCny ?? 0,
      tokens: input.tokens ?? 0,
    },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  return published.artifact.artifactId;
}

export async function readArtifactText(
  store: Store,
  artifactId: string,
): Promise<string> {
  const artifact = await store.artifactStore.findById(artifactId);
  if (!artifact) {
    return "";
  }
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    return "";
  }
  const bytes = await store.blobClient.get(blob.storageKey);
  return new TextDecoder().decode(bytes);
}

export async function formatAppliedFiles(repoRoot: string): Promise<void> {
  const changed = await runProcess("git", ["diff", "--name-only", "HEAD"], {
    cwd: repoRoot,
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
  });
  if (changed.exitCode !== 0) {
    return;
  }
  const files = changed.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => /\.(ts|tsx|js|jsx|json|css|md|yaml|yml)$/.test(file));
  if (files.length === 0) {
    return;
  }
  const bun = commandOnPath("bun") ?? "bun";
  await runProcess(bun, ["x", "biome", "check", "--write", ...files], {
    cwd: repoRoot,
    timeoutMs: 120_000,
    maxOutputBytes: 200_000,
  });
}

export async function runPostApplyChecks(
  repoRoot: string,
  risk: IterationRisk,
  changedFiles: string[] = [],
): Promise<{ ok: boolean; feedback: string }> {
  const bun = commandOnPath("bun") ?? "bun";
  const failures: string[] = [];

  const lintFiles = changedFiles.filter((file) =>
    /\.(ts|tsx|js|jsx|json|jsonc|css|md|yaml|yml)$/.test(file),
  );
  if (lintFiles.length > 0) {
    const result = await runProcess(
      bun,
      ["x", "biome", "check", ...lintFiles],
      {
        cwd: repoRoot,
        timeoutMs: 5 * 60 * 1000,
        maxOutputBytes: 100_000,
      },
    );
    if (result.exitCode !== 0 || result.timedOut) {
      failures.push(
        `[lint:changed] exit=${result.exitCode} timeout=${result.timedOut}\n${[result.stdout, result.stderr].join("\n").slice(-3000)}`,
      );
    }
  }

  const checks = ["typecheck", "test"];
  if (risk === "medium") {
    checks.push("web:build");
  }
  for (const check of checks) {
    const result = await runProcess(bun, ["run", check], {
      cwd: repoRoot,
      timeoutMs: 20 * 60 * 1000,
      maxOutputBytes: 200_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      failures.push(
        `[${check}] exit=${result.exitCode} timeout=${result.timedOut}\n${[result.stdout, result.stderr].join("\n").slice(-3000)}`,
      );
    }
  }
  return {
    ok: failures.length === 0,
    feedback: failures.join("\n\n"),
  };
}

export interface ApplyDiffInput {
  repoRoot: string;
  iterationId: string;
  taskId: string;
  ticketId: string;
  diff: string;
  baseSha: string;
  changedFiles: string[];
  risk: IterationRisk;
  commitMessage: string;
  /**
   * External kit home for the security audit sink. Defaults to `KIT_HOME`;
   * tests inject a temp home so they never touch the operator's real one.
   */
  kitHome?: string;
}

export interface ApplyDiffResult extends ApplyPatchResult {
  patchFile: string;
  backupDir: string;
}

interface PatchSummary {
  files: string[];
  contents: Record<string, string>;
  deletedFiles: string[];
}

/** Extracts touched paths, added lines and deletions from a git diff. */
export function summarizePatch(diff: string): PatchSummary {
  const files: string[] = [];
  const contents: Record<string, string> = {};
  const deletedFiles: string[] = [];
  let current: string | null = null;
  // Only the two header lines directly after `diff --git` are headers; a body
  // line that happens to start with `--- ` or `+++ ` must stay content.
  let phase: "file" | "minus" | "body" = "body";

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      current = null;
      phase = "file";
      continue;
    }
    if (phase === "file" && raw.startsWith("--- ")) {
      const target = diffPath(raw.slice(4));
      current = target === "/dev/null" ? null : target;
      phase = "minus";
      continue;
    }
    if (phase === "minus" && raw.startsWith("+++ ")) {
      const target = diffPath(raw.slice(4));
      phase = "body";
      if (target === "/dev/null") {
        if (current && !deletedFiles.includes(current)) {
          deletedFiles.push(current);
        }
        current = null;
        continue;
      }
      current = target;
      if (!files.includes(current)) {
        files.push(current);
      }
      contents[current] ??= "";
      continue;
    }
    if (raw.startsWith("+") && current) {
      contents[current] = `${contents[current] ?? ""}${raw.slice(1)}\n`;
    }
  }

  return { files, contents, deletedFiles };
}

function diffPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }
  return normalizePath(trimmed.replace(/^[ab]\//, ""));
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function applyDiffToRepo(
  input: ApplyDiffInput,
): Promise<ApplyDiffResult> {
  const { patchFile, backupDir } = await writeApplyPatch(
    input.repoRoot,
    safe(input.iterationId),
    safe(input.taskId),
    input.diff,
  );

  // Fail-closed security gate (70 §3.3/§5): the patch decision covers escaping
  // paths, control-plane disables and audit/approval deletions; the target
  // pass classifies each resolved destination against the recovery surface.
  // A violation is audited by the helpers and converts to a blocked result.
  const patch = summarizePatch(input.diff);
  const files = [
    ...new Set([...input.changedFiles.map(normalizePath), ...patch.files]),
  ].filter((file) => file.length > 0);
  const securityOptions = {
    actor: `iterate:${input.iterationId}/${input.taskId}`,
    ...(input.kitHome !== undefined ? { kitHome: input.kitHome } : {}),
  };
  try {
    await enforcePatchSecurity(
      {
        files,
        contents: patch.contents,
        deletedFiles: patch.deletedFiles,
        ...(input.kitHome !== undefined ? { kitHome: input.kitHome } : {}),
      },
      securityOptions,
    );
    await enforceWriteTargetsAllowed(
      files.map((file) => path.resolve(input.repoRoot, file)),
      { ...securityOptions, action: "agent-patch" },
    );
  } catch (error) {
    if (!isSecurityInvariantError(error)) {
      throw error;
    }
    return {
      status: "blocked",
      reason: `security invariant blocked the patch: ${error.message}`,
      headBefore: "",
      baseDrifted: false,
      patchFile,
      backupDir,
    };
  }

  const applied = await applyPatchToRepo({
    repoRoot: input.repoRoot,
    patchFile,
    baseSha: input.baseSha,
    changedFiles: input.changedFiles,
    ticketId: input.ticketId,
    commitMessage: input.commitMessage,
    format: (root) => formatAppliedFiles(root),
    postCheck: (root) =>
      runPostApplyChecks(root, input.risk, input.changedFiles),
  });
  return { ...applied, patchFile, backupDir };
}

export function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
