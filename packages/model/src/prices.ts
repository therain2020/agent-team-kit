/**
 * Versioned model price table (60 §3.3, D-12).
 *
 * Every price carries the table version and an `effectiveAt` timestamp so a
 * historical {@link CostRecord} can always be reproduced from the unit price it
 * was charged at, even after a provider changes its rates. Unknown models are
 * never priced as a silent zero: resolution returns `tracked: false` with an
 * explicit reason that rides along to the ledger.
 */

export type PriceCurrency = "CNY";

export interface ModelPriceEntry {
  /** Alias or provider model id the price applies to. */
  modelId: string;
  provider: string;
  currency: PriceCurrency;
  /** CNY per 1,000 input tokens. */
  inputPer1k: number;
  /** CNY per 1,000 output tokens. */
  outputPer1k: number;
  /** ISO timestamp from which this entry is active. */
  effectiveAt: string;
}

export interface PriceTable {
  version: string;
  /** ISO timestamp from which this table is the active default. */
  effectiveAt: string;
  entries: ModelPriceEntry[];
}

export interface ResolvedModelPrice {
  tracked: boolean;
  modelId: string;
  provider: string;
  currency: PriceCurrency;
  /** CNY per 1,000 tokens; 0 when untracked. */
  inputPer1k: number;
  outputPer1k: number;
  inputPer1kMicro: number;
  outputPer1kMicro: number;
  priceVersion: string;
  effectiveAt: string;
  untrackedReason: string | null;
}

export const MICRO_CNY_PER_CNY = 1_000_000;

export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: "2026-11-01",
  effectiveAt: "2026-11-01T00:00:00.000Z",
  entries: [
    {
      modelId: "deepseek-flash",
      provider: "deepseek",
      currency: "CNY",
      inputPer1k: 0.001,
      outputPer1k: 0.002,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
    {
      modelId: "deepseek-pro",
      provider: "deepseek",
      currency: "CNY",
      inputPer1k: 0.002,
      outputPer1k: 0.008,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
  ],
};

/**
 * Load the active price table. `KIT_PRICE_TABLE_JSON` overrides the bundled
 * table wholesale (version, effectiveAt and entries); a malformed override
 * throws instead of silently falling back, so a typo cannot quietly zero out
 * costs.
 */
export function loadPriceTable(
  env: Record<string, string | undefined> = process.env,
): PriceTable {
  const raw = env.KIT_PRICE_TABLE_JSON;
  if (!raw || raw.trim() === "") {
    return DEFAULT_PRICE_TABLE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `KIT_PRICE_TABLE_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePriceTable(parsed);
}

export function validatePriceTable(value: unknown): PriceTable {
  if (typeof value !== "object" || value === null) {
    throw new Error("price table must be an object");
  }
  const table = value as Record<string, unknown>;
  if (typeof table.version !== "string" || table.version.trim() === "") {
    throw new Error("price table requires a non-empty version");
  }
  const effectiveAt = isoOrNull(table.effectiveAt);
  if (!effectiveAt) {
    throw new Error("price table requires an ISO effectiveAt");
  }
  if (!Array.isArray(table.entries)) {
    throw new Error("price table requires an entries array");
  }
  const entries = table.entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`price entry ${index} must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const modelId = typeof item.modelId === "string" ? item.modelId.trim() : "";
    if (!modelId) {
      throw new Error(`price entry ${index} requires modelId`);
    }
    const provider =
      typeof item.provider === "string" ? item.provider.trim() : "";
    if (!provider) {
      throw new Error(`price entry ${modelId} requires provider`);
    }
    const currency = item.currency ?? "CNY";
    if (currency !== "CNY") {
      throw new Error(`price entry ${modelId} has unsupported currency`);
    }
    const entryEffectiveAt = isoOrNull(item.effectiveAt);
    if (!entryEffectiveAt) {
      throw new Error(`price entry ${modelId} requires an ISO effectiveAt`);
    }
    return {
      modelId,
      provider,
      currency: "CNY" as const,
      inputPer1k: nonNegative(item.inputPer1k, modelId, "inputPer1k"),
      outputPer1k: nonNegative(item.outputPer1k, modelId, "outputPer1k"),
      effectiveAt: entryEffectiveAt,
    };
  });
  return { version: table.version.trim(), effectiveAt, entries };
}

/**
 * Resolve the price for a model at a point in time: the newest entry that
 * matches the id and has already taken effect. Unknown id yields
 * `tracked: false` and a reason — callers must surface it, not treat it as 0.
 */
export function resolveModelPrice(
  table: PriceTable,
  modelId: string,
  at: Date | string = new Date(),
): ResolvedModelPrice {
  const atIso = toIso(at);
  const candidates = table.entries
    .filter((entry) => entry.modelId === modelId)
    .filter((entry) => entry.effectiveAt <= atIso)
    .sort((a, b) => (a.effectiveAt < b.effectiveAt ? 1 : -1));
  const entry = candidates[0];
  if (!entry) {
    return {
      tracked: false,
      modelId,
      provider: "unknown",
      currency: "CNY",
      inputPer1k: 0,
      outputPer1k: 0,
      inputPer1kMicro: 0,
      outputPer1kMicro: 0,
      priceVersion: table.version,
      effectiveAt: table.effectiveAt,
      untrackedReason: `no price for model "${modelId}" in price table ${table.version}`,
    };
  }
  return {
    tracked: true,
    modelId,
    provider: entry.provider,
    currency: entry.currency,
    inputPer1k: entry.inputPer1k,
    outputPer1k: entry.outputPer1k,
    inputPer1kMicro: cnyToMicro(entry.inputPer1k),
    outputPer1kMicro: cnyToMicro(entry.outputPer1k),
    priceVersion: table.version,
    effectiveAt: entry.effectiveAt,
    untrackedReason: null,
  };
}

/** Cost in micro-CNY for a call, computed from the stamped unit prices. */
export function computeCostMicro(
  price: Pick<ResolvedModelPrice, "inputPer1kMicro" | "outputPer1kMicro">,
  inputTokens: number,
  outputTokens: number,
): number {
  const cost =
    (Math.max(0, inputTokens) / 1000) * price.inputPer1kMicro +
    (Math.max(0, outputTokens) / 1000) * price.outputPer1kMicro;
  return Math.round(cost);
}

export function cnyToMicro(cny: number): number {
  return Math.round(cny * MICRO_CNY_PER_CNY);
}

export interface ToolPriceConfig {
  /** CNY per executed tool call. */
  unitPriceCny: number;
  priceVersion: string;
  tracked: true;
}

export const DEFAULT_TOOL_PRICE_VERSION = "tools@1";

/**
 * Tool calls are priced either explicitly (per-tool override or a flat rate) or
 * explicitly at zero. Both are tracked; "unknown tool pricing" is not a state
 * we allow.
 */
export function loadToolPriceConfig(
  env: Record<string, string | undefined> = process.env,
): ToolPriceConfig {
  const unitPriceCny = parseCny(env.KIT_TOOL_CALL_PRICE_CNY, 0);
  return {
    unitPriceCny,
    priceVersion: env.KIT_TOOL_PRICE_VERSION ?? DEFAULT_TOOL_PRICE_VERSION,
    tracked: true,
  };
}

export function resolveToolCallPrice(
  toolName: string,
  env: Record<string, string | undefined> = process.env,
): ToolPriceConfig {
  const key = `KIT_TOOL_PRICE_${toolName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CNY`;
  const flat = loadToolPriceConfig(env);
  return {
    unitPriceCny: parseCny(env[key], flat.unitPriceCny),
    priceVersion: flat.priceVersion,
    tracked: true,
  };
}

function parseCny(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid CNY price: ${raw}`);
  }
  return parsed;
}

function nonNegative(value: unknown, modelId: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`price entry ${modelId} has invalid ${field}`);
  }
  return value;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    return null;
  }
  return new Date(value).toISOString();
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}
