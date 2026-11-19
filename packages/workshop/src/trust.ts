import type { WorkshopManifest } from "@kit/core";
import {
  type Trust,
  type TrustedKey,
  canonicalPayload,
  loadTrustedKeys,
  parseTrustedKeys,
  verifySignature,
} from "@kit/market";

/**
 * Workshop trust grading. The Ed25519 verification and keyring now live in the
 * single market kernel (`@kit/market`); this module keeps the historical
 * `Workshop*` names so callers and records stay stable.
 */

export { TRUSTED_KEYS_FILE, TRUSTED_KEYS_ENV } from "@kit/market";

export type WorkshopTrustLevel = Trust["level"];

export type WorkshopSignatureStatus = Trust["signature"];

export type WorkshopTrustedKey = TrustedKey;

export type WorkshopTrust = Trust;

export function canonicalManifestPayload(manifest: WorkshopManifest): Buffer {
  return canonicalPayload(manifest);
}

export function verifyWorkshopSignature(
  manifest: WorkshopManifest,
  keys: WorkshopTrustedKey[],
): WorkshopTrust {
  return verifySignature(manifest, keys);
}

export const parseWorkshopTrustedKeys = parseTrustedKeys;

export function loadWorkshopTrustedKeys(
  options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<WorkshopTrustedKey[]> {
  return loadTrustedKeys(options);
}
