import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Ed25519 trust grading shared by packs, pipelines, sources and templates
 * (plan 88 §3.5, D-69). A manifest carries an optional signature; the kernel
 * verifies it against a trusted keyring and grades the item as `builtin`,
 * `verified` or `community` (unsigned / invalid / unknown key).
 *
 * The keyring file name and env var keep the historical `workshop-` prefix so
 * existing deployments keep working; sources use the same keyring because the
 * kernel is single.
 */

export const TRUSTED_KEYS_FILE = "workshop-trusted-keys.json";
export const TRUSTED_KEYS_ENV = "KIT_WORKSHOP_TRUSTED_KEYS";

export type TrustLevel = "builtin" | "verified" | "community";

export type SignatureStatus = "valid" | "invalid" | "unknown-key" | "missing";

export interface TrustedKey {
  keyId: string;
  publicKey: string;
  tier: "builtin" | "verified";
}

export interface Trust {
  level: TrustLevel;
  signature: SignatureStatus;
  keyId?: string;
}

export interface SignatureValue {
  algorithm?: string;
  keyId: string;
  value: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Canonical, order-independent payload of a manifest without its signature. */
export function canonicalPayload(record: object): Buffer {
  const { signature: _signature, ...rest } = record as {
    signature?: unknown;
  };
  return Buffer.from(stableStringify(rest), "utf8");
}

export function verifySignature(record: object, keys: TrustedKey[]): Trust {
  const signature = (record as { signature?: SignatureValue }).signature;
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
      canonicalPayload(record),
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

export function parseTrustedKeys(value: unknown): TrustedKey[] {
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

export async function loadTrustedKeys(
  options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): Promise<TrustedKey[]> {
  const env = options.env ?? process.env;
  const configured = env[TRUSTED_KEYS_ENV]?.trim();
  if (!configured) {
    const file = path.join(options.root ?? process.cwd(), TRUSTED_KEYS_FILE);
    try {
      return parseTrustedKeys(JSON.parse(await readFile(file, "utf8")));
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
      `invalid ${TRUSTED_KEYS_ENV}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseTrustedKeys(raw);
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
