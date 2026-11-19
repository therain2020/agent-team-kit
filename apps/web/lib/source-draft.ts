import { type SourceCandidateInput, credentialHeaderNames } from "@kit/job";
import type { SourceCandidate } from "@kit/source";

/**
 * Map a market candidate onto the pack-agnostic facts the job composer needs.
 * Header values never leave this layer: only names and a credential verdict
 * cross into the draft (issue #123, D-64).
 */
export function toSourceCandidateInput(
  candidate: SourceCandidate,
): SourceCandidateInput {
  const manifest = candidate.manifest;
  return {
    repo: candidate.repo,
    htmlUrl: candidate.htmlUrl,
    description: candidate.description,
    stars: candidate.stars,
    topics: candidate.topics,
    updatedAt: candidate.updatedAt,
    ...(candidate.manifestError
      ? { manifestError: candidate.manifestError }
      : {}),
    ...(manifest
      ? {
          manifest: {
            name: manifest.metadata.name,
            version: manifest.metadata.version,
            type: manifest.spec.type,
            endpoint: manifest.spec.request.url,
            headerNames: Object.keys(manifest.spec.request.headers ?? {}),
            credentialHeaders: credentialHeaderNames(
              manifest.spec.request.headers,
            ),
            ...(manifest.metadata.license
              ? { license: manifest.metadata.license }
              : {}),
            ...(manifest.metadata.homepage
              ? { homepage: manifest.metadata.homepage }
              : {}),
            ...(manifest.compliance?.tos
              ? { tos: manifest.compliance.tos }
              : {}),
            ...(manifest.compliance?.attribution
              ? { attribution: manifest.compliance.attribution }
              : {}),
            ...(manifest.compliance?.notes
              ? { complianceNotes: manifest.compliance.notes }
              : {}),
          },
        }
      : {}),
  };
}

export function toSourceCandidateInputs(
  candidates: SourceCandidate[],
): SourceCandidateInput[] {
  return candidates.map(toSourceCandidateInput);
}
