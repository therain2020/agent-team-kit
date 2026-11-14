import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkshopManifest } from "@kit/core";

export const TRUSTED_KEYS_FILE = "workshop-trusted-keys.json";

export type WorkshopTrustLevel = "builtin" | "verified" | "community";

export type WorkshopSignatureStatus =
  | "valid"
  | "invalid"
  | "unknown-key"
  | "missing";

export interface WorkshopTrustedKey {
  keyId: string;
  publicKey: string;
  tier: "builtin" | "verified";
}

export interface WorkshopTrust {
  level: WorkshopTrustLevel;
  signature: WorkshopSignatureStatus;
  keyId?: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function canonicalManifestPayload(manifest: WorkshopManifest): Buffer {
  const { signature: _signature, ...rest } = manifest;
  return Buffer.from(stableStringify(rest), "utf8");
}

export function verifyWorkshopSignature(
  manifest: WorkshopManifest,
  keys: WorkshopTrustedKey[],
): WorkshopTrust {
  const signature = manifest.signature;
  if (!signature) {
    return { level: "community", signature: "missing" };
  }
  const key = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (!key) {
    return {
      level: "community",
      signature: "unknown-key",
      keyId: signature.keyId,
    };
  }

  let valid = false;
  try {
    valid = cryptoVerify(
      null,
      canonicalManifestPayload(manifest),
      createPublicKey(key.publicKey),
      Buffer.from(signature.value, "base64"),
    );
  } catch {
    valid = false;
  }

  if (!valid) {
    return { level: "community", signature: "invalid", keyId: signature.keyId };
  }
  return {
    level: key.tier === "builtin" ? "builtin" : "verified",
    signature: "valid",
    keyId: key.keyId,
  };
}

export function parseWorkshopTrustedKeys(value: unknown): WorkshopTrustedKey[] {
  const raw = Array.isArray(value)
    ? value
    : (value as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(raw)) {
    throw new Error("workshop keyring must be { keys: [...] }");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`workshop keyring entry ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const { keyId, publicKey, tier } = record;
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
      throw new Error(`workshop keyring entry ${index} has an invalid keyId`);
    }
    if (
      typeof publicKey !== "string" ||
      !publicKey.includes("PUBLIC KEY-----")
    ) {
      throw new Error(
        `workshop keyring entry ${index} has an invalid publicKey`,
      );
    }
    if (tier !== undefined && tier !== "builtin" && tier !== "verified") {
      throw new Error(
        `workshop keyring entry ${index} has an invalid tier (builtin|verified)`,
      );
    }
    return {
      keyId,
      publicKey,
      tier: tier === "builtin" ? "builtin" : "verified",
    };
  });
}

export async function loadWorkshopTrustedKeys(
  options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<WorkshopTrustedKey[]> {
  const env = options.env ?? process.env;
  const configured = env.KIT_WORKSHOP_TRUSTED_KEYS?.trim();
  if (!configured) {
    const file = path.join(options.root ?? process.cwd(), TRUSTED_KEYS_FILE);
    try {
      return parseWorkshopTrustedKeys(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(
        `invalid ${TRUSTED_KEYS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(
      configured.startsWith("{") || configured.startsWith("[")
        ? configured
        : await readFile(path.resolve(configured), "utf8"),
    );
  } catch (error) {
    throw new Error(
      `invalid KIT_WORKSHOP_TRUSTED_KEYS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseWorkshopTrustedKeys(raw);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}
