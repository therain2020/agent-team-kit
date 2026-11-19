import { createHash } from "node:crypto";
import type { ArtifactVersion, Manifest } from "@kit/core";
import type { BlobClient } from "./blob";
import type {
  ArtifactStore,
  BlobRepository,
  ManifestStore,
} from "./repositories";

/**
 * Recovery-time ArtifactVersion integrity verification (61 §3.5): a recovered
 * run may only continue when every committed artifact still matches its
 * Manifest and its blob content hash. This module reads through the existing
 * repositories; it deliberately does not rewrite artifact storage.
 */
export interface ArtifactIntegrityDependencies {
  artifactStore: Pick<ArtifactStore, "listByRun" | "findById">;
  manifests: Pick<ManifestStore, "get">;
  blobs: Pick<BlobRepository, "findById">;
  blobClient: Pick<BlobClient, "get">;
}

export type ArtifactIntegrityProblemCode =
  | "not_committed"
  | "manifest_missing"
  | "manifest_run_mismatch"
  | "manifest_workspace_mismatch"
  | "manifest_stage_missing"
  | "blob_missing"
  | "blob_unreadable"
  | "blob_sha256_mismatch"
  | "blob_size_mismatch"
  | "input_missing";

export interface ArtifactIntegrityProblem {
  code: ArtifactIntegrityProblemCode;
  detail: string;
}

export interface ArtifactIntegrityCheck {
  artifactId: string;
  version: number;
  manifestId: string;
  blobId: string;
  stageId: string | null;
  sha256: string | null;
  ok: boolean;
  problems: ArtifactIntegrityProblem[];
}

export interface RunIntegrityReport {
  runId: string;
  ok: boolean;
  checked: number;
  checks: ArtifactIntegrityCheck[];
  failures: ArtifactIntegrityCheck[];
}

export interface VerifyRunArtifactsOptions {
  /**
   * Re-read blob content and recompute sha256. Defaults to true; callers with
   * very large runs may trade verification depth for time but should not.
   */
  recomputeContent?: boolean;
  /**
   * Skip the manifest-input existence walk (input artifacts may legitimately
   * live in another run's retention window). Defaults to false.
   */
  skipInputRefs?: boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface CheckOptions {
  expectedRunId: string | null;
  recomputeContent: boolean;
  skipInputRefs: boolean;
}

async function checkArtifact(
  deps: ArtifactIntegrityDependencies,
  artifact: ArtifactVersion,
  options: CheckOptions,
): Promise<ArtifactIntegrityCheck> {
  const problems: ArtifactIntegrityProblem[] = [];
  const manifest: Manifest | null = await deps.manifests.get(
    artifact.manifestId,
  );

  if (artifact.status !== "committed") {
    problems.push({
      code: "not_committed",
      detail: `artifact status is ${artifact.status}`,
    });
  }

  if (!manifest) {
    problems.push({
      code: "manifest_missing",
      detail: `manifest ${artifact.manifestId} not found`,
    });
  } else {
    if (
      options.expectedRunId !== null &&
      manifest.runId !== options.expectedRunId
    ) {
      problems.push({
        code: "manifest_run_mismatch",
        detail: `manifest run ${manifest.runId} != ${options.expectedRunId}`,
      });
    }
    if (manifest.workspaceId !== artifact.workspaceId) {
      problems.push({
        code: "manifest_workspace_mismatch",
        detail: `manifest workspace ${manifest.workspaceId} != ${artifact.workspaceId}`,
      });
    }
    if (!manifest.stageId.trim()) {
      problems.push({
        code: "manifest_stage_missing",
        detail: "manifest has no stageId",
      });
    }
    if (!options.skipInputRefs) {
      for (const input of manifest.inputs) {
        const found = await deps.artifactStore
          .findById(input.artifactId, input.version)
          .catch(() => null);
        if (!found) {
          problems.push({
            code: "input_missing",
            detail: `input ${input.artifactId}@${input.version} not found`,
          });
        }
      }
    }
  }

  let actualSha: string | null = null;
  const blob = await deps.blobs.findById(artifact.blobId);
  if (!blob) {
    problems.push({
      code: "blob_missing",
      detail: `blob ${artifact.blobId} not found`,
    });
  } else if (options.recomputeContent) {
    try {
      const bytes = await deps.blobClient.get(blob.storageKey);
      actualSha = sha256(bytes);
      if (actualSha !== blob.sha256) {
        problems.push({
          code: "blob_sha256_mismatch",
          detail: `content ${actualSha} != recorded ${blob.sha256}`,
        });
      }
      if (bytes.byteLength !== blob.size) {
        problems.push({
          code: "blob_size_mismatch",
          detail: `content size ${bytes.byteLength} != recorded ${blob.size}`,
        });
      }
    } catch (error) {
      problems.push({
        code: "blob_unreadable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    artifactId: artifact.artifactId,
    version: artifact.version,
    manifestId: artifact.manifestId,
    blobId: artifact.blobId,
    stageId: manifest?.stageId ?? null,
    sha256: actualSha,
    ok: problems.length === 0,
    problems,
  };
}

/**
 * Verifies every committed ArtifactVersion produced by `runId` against its
 * Manifest and blob content. Returns a per-artifact report; never throws for
 * a failed check (only for an unexpected repository error).
 */
export async function verifyRunArtifacts(
  deps: ArtifactIntegrityDependencies,
  runId: string,
  options: VerifyRunArtifactsOptions = {},
): Promise<RunIntegrityReport> {
  const artifacts = await deps.artifactStore.listByRun(runId);
  const checks: ArtifactIntegrityCheck[] = [];

  for (const artifact of artifacts) {
    checks.push(
      await checkArtifact(deps, artifact, {
        expectedRunId: runId,
        recomputeContent: options.recomputeContent ?? true,
        skipInputRefs: options.skipInputRefs ?? false,
      }),
    );
  }

  const failures = checks.filter((check) => !check.ok);
  return {
    runId,
    ok: failures.length === 0,
    checked: checks.length,
    checks,
    failures,
  };
}

export interface ArtifactVersionIntegrityReport {
  artifactId: string;
  version: number;
  ok: boolean;
  problems: ArtifactIntegrityProblem[];
}

/**
 * Single-version variant used where a run should not be scanned end-to-end
 * (e.g. verifying an artifact before reusing it after a crash).
 */
export async function verifyArtifactVersion(
  deps: ArtifactIntegrityDependencies,
  artifactId: string,
  version = 1,
): Promise<ArtifactVersionIntegrityReport> {
  const artifact = await deps.artifactStore.findById(artifactId, version);
  if (!artifact) {
    return {
      artifactId,
      version,
      ok: false,
      problems: [{ code: "manifest_missing", detail: "artifact not found" }],
    };
  }
  const check = await checkArtifact(deps, artifact, {
    expectedRunId: null,
    recomputeContent: true,
    skipInputRefs: true,
  });
  return {
    artifactId,
    version,
    ok: check.ok,
    problems: check.problems,
  };
}
