import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  MAX_MANIFEST_BYTES,
  type TrustedKey,
  assertRepo,
  createMarketSearchCache,
  defaultBranch,
  fetchRawFile,
  isSafeRelPath,
  loadTrustedKeys,
  readJsonFile,
  resolveCommit,
  scanSecrets,
  searchMarket,
  sha256Hex,
  verifySignature,
  writeFileAtomic,
  writeJsonAtomic,
} from "@kit/market";
import { parse } from "yaml";
import { fetchFromDefinition, validateSourceEndpoint } from "./adapters";
import {
  type InstalledSource,
  type RawSourceItem,
  SOURCE_TOPIC,
  type SourceCandidate,
  type SourceDefinition,
  type SourceMeta,
  type SourceTrust,
  type SourceTrustLevel,
  sourceDefinitionSchema,
} from "./types";

/**
 * Source market adapter (plan 88 §3.4/§6.1 M1, D-69).
 *
 * Search, commit pinning, raw reads, trust grading, secret scanning and record
 * writing all come from the shared `@kit/market` kernel. This module only adds
 * what is source-specific: the `source.yaml` schema, the `sources/` destination
 * and the RSS/JSON/github fetch adapter.
 */

const BUILTIN_NAMES = new Set(["hn", "arxiv", "github"]);
const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const searchCache = createMarketSearchCache<SourceDefinition>();

export function getSourcesRoot(root?: string): string {
  return path.resolve(
    root ?? process.env.KIT_SOURCES_ROOT ?? path.join(process.cwd(), "sources"),
  );
}

export async function searchSources(
  options: {
    query?: string;
    topic?: string;
    limit?: number;
    token?: string;
    root?: string;
    keys?: TrustedKey[];
  } = {},
): Promise<SourceCandidate[]> {
  const keys = options.keys ?? (await loadKeysOrEmpty());
  const results = await searchMarket<SourceDefinition>({
    topic: options.topic ?? SOURCE_TOPIC,
    manifestFile: "source.yaml",
    query: options.query,
    limit: options.limit,
    token: options.token,
    cache: searchCache,
    parse: (raw) => parseSourceManifest(raw),
  });

  return results.map((candidate) => {
    const mapped: SourceCandidate = {
      repo: candidate.repo,
      htmlUrl: candidate.htmlUrl,
      description: candidate.description,
      stars: candidate.stars,
      topics: candidate.topics,
      updatedAt: candidate.updatedAt,
    };
    if (candidate.manifest) {
      mapped.manifest = candidate.manifest;
      mapped.trust = verifySignature(candidate.manifest, keys);
    }
    if (candidate.manifestError) {
      mapped.manifestError = candidate.manifestError;
    }
    return mapped;
  });
}

export async function installSource(input: {
  repo: string;
  ref?: string;
  file?: string;
  token?: string;
  root?: string;
  acceptThirdParty: boolean;
  /** Trusted signing keys; defaults to the shared market keyring. */
  keys?: TrustedKey[];
  /** Override the endpoint validator (tests pass a no-op). */
  validateEndpoint?: (url: string) => Promise<void>;
}): Promise<InstalledSource> {
  if (!input.acceptThirdParty) {
    throw new Error("third-party sources require explicit confirmation");
  }
  assertRepo(input.repo);
  const file = input.file ?? "source.yaml";
  if (!isSafeRelPath(file)) {
    throw new Error("invalid manifest path");
  }

  const ref =
    input.ref || (await defaultBranch(input.repo, { token: input.token }));
  const commit = await resolveCommit(input.repo, ref, { token: input.token });
  const raw = await fetchRawFile(input.repo, commit, file, {
    token: input.token,
  });
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("source.yaml exceeds 64KB");
  }

  const parsed = parseSourceManifest(raw);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }
  const definition = parsed.manifest;
  if (BUILTIN_NAMES.has(definition.metadata.name)) {
    throw new Error(
      `source name is reserved by a builtin: ${definition.metadata.name}`,
    );
  }

  const validateEndpoint = input.validateEndpoint ?? validateSourceEndpoint;
  await validateEndpoint(definition.spec.request.url);

  // Same secret scan packs run; source.yaml is the only installed file.
  const secretFindings = scanSecrets([{ file, content: raw }]);
  if (secretFindings.length > 0) {
    throw new Error(
      `source manifest contains secret-like content: ${secretFindings
        .map((finding) => `${finding.file}:${finding.line} (${finding.label})`)
        .join("; ")}`,
    );
  }

  const keys = input.keys ?? (await loadKeysOrEmpty());
  const trust = verifySignature(definition, keys);
  const manifestSha256 = sha256Hex(raw);

  const root = getSourcesRoot(input.root);
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${definition.metadata.name}.yaml`);
  const metaPath = path.join(root, `${definition.metadata.name}.meta.json`);
  const meta: SourceMeta = {
    kind: "source",
    id: definition.metadata.name,
    name: definition.metadata.name,
    version: definition.metadata.version,
    entry: file,
    license: definition.metadata.license,
    repo: input.repo,
    commit,
    manifestSha256,
    installedAt: new Date().toISOString(),
    trust: trust.level,
    trustDetail: trust,
    permissions: { network: true, filesystem: "readonly", code: false },
    files: { [file]: manifestSha256 },
    manifest: {
      id: definition.metadata.name,
      name: definition.metadata.name,
      version: definition.metadata.version,
      kind: "source",
      description: definition.metadata.description ?? "",
    },
    homepage: definition.metadata.homepage,
    secretScan: "passed",
  };

  await writeFileAtomic(target, raw);
  try {
    await writeJsonAtomic(metaPath, meta);
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
  return { definition, meta, file: target };
}

export async function listInstalledSources(
  root?: string,
): Promise<InstalledSource[]> {
  const dir = getSourcesRoot(root);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const sources: InstalledSource[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      continue;
    }
    const stem = entry.name.slice(0, -".yaml".length);
    try {
      const source = await loadInstalledSource(stem, dir);
      if (source) {
        sources.push(source);
      }
    } catch {
      // invalid installations stay visible in search but are skipped here
    }
  }
  return sources.sort((a, b) =>
    a.definition.metadata.name.localeCompare(b.definition.metadata.name),
  );
}

export async function loadInstalledSource(
  name: string,
  root?: string,
): Promise<InstalledSource | null> {
  if (!SOURCE_NAME_PATTERN.test(name)) {
    return null;
  }
  const dir = getSourcesRoot(root);
  const manifestPath = path.join(dir, `${name}.yaml`);
  if (!existsSync(manifestPath)) {
    return null;
  }
  const raw = await readFile(manifestPath, "utf8");
  const parsed = sourceDefinitionSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${name}: invalid source.yaml: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  const metaPath = path.join(dir, `${name}.meta.json`);
  const meta = normalizeMeta(name, await readJsonFile(metaPath), raw);
  return { definition: parsed.data, meta, file: manifestPath };
}

export async function removeSource(name: string, root?: string): Promise<void> {
  if (!SOURCE_NAME_PATTERN.test(name) || BUILTIN_NAMES.has(name)) {
    throw new Error("invalid or builtin source");
  }
  const dir = getSourcesRoot(root);
  await rm(path.join(dir, `${name}.yaml`), { force: true });
  await rm(path.join(dir, `${name}.meta.json`), { force: true });
}

export async function testSource(
  name: string,
  options: { root?: string; limit?: number } = {},
): Promise<{ items: RawSourceItem[] }> {
  const installed = await loadInstalledSource(name, options.root);
  if (!installed) {
    throw new Error(`source not installed: ${name}`);
  }
  const items = await fetchFromDefinition(
    installed.definition,
    options.limit ?? 3,
  );
  return { items };
}

function parseSourceManifest(
  raw: string,
): { manifest: SourceDefinition } | { error: string } {
  const parsed = sourceDefinitionSchema.safeParse(parse(raw));
  if (parsed.success) {
    return { manifest: parsed.data };
  }
  return {
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n"),
  };
}

function normalizeMeta(
  name: string,
  raw: unknown,
  manifestRaw: string,
): SourceMeta {
  const fallback: SourceMeta = {
    kind: "source",
    id: name,
    name,
    entry: `${name}.yaml`,
    repo: "local",
    commit: "working-tree",
    manifestSha256: sha256Hex(manifestRaw),
    installedAt: new Date(0).toISOString(),
    trust: "community",
    trustDetail: { level: "community", signature: "missing" },
    secretScan: "passed",
  };
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const record = raw as Record<string, unknown>;
  const trustDetail =
    normalizeTrustDetail(record.trustDetail) ??
    normalizeTrustDetail(record.trust) ??
    fallback.trustDetail;
  const trust =
    normalizeTrustLevel(record.trust) ?? trustDetail?.level ?? fallback.trust;
  return {
    ...fallback,
    kind: record.kind === "source" ? "source" : fallback.kind,
    id: asString(record.id) ?? fallback.id,
    name: asString(record.name) ?? name,
    version: asString(record.version) ?? fallback.version,
    entry: asString(record.entry) ?? fallback.entry,
    license: asString(record.license) ?? fallback.license,
    repo: asString(record.repo) ?? fallback.repo,
    commit: asString(record.commit) ?? fallback.commit,
    manifestSha256: asString(record.manifestSha256) ?? fallback.manifestSha256,
    installedAt: asString(record.installedAt) ?? fallback.installedAt,
    trust,
    ...(trustDetail ? { trustDetail } : {}),
    homepage: asString(record.homepage) ?? fallback.homepage,
    ...(record.secretScan === "passed"
      ? { secretScan: "passed" as const }
      : {}),
  };
}

function normalizeTrustLevel(
  value: unknown,
): SourceTrustLevel | "third-party" | undefined {
  if (
    value === "builtin" ||
    value === "verified" ||
    value === "community" ||
    value === "third-party"
  ) {
    return value;
  }
  return undefined;
}

function normalizeTrustDetail(value: unknown): SourceTrust | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const level = normalizeTrustLevel(record.level);
  if (level === undefined || level === "third-party") {
    return undefined;
  }
  const signature = record.signature;
  if (
    signature !== "valid" &&
    signature !== "invalid" &&
    signature !== "unknown-key" &&
    signature !== "missing"
  ) {
    return undefined;
  }
  return {
    level,
    signature,
    ...(typeof record.keyId === "string" ? { keyId: record.keyId } : {}),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function loadKeysOrEmpty(): Promise<TrustedKey[]> {
  try {
    return await loadTrustedKeys();
  } catch {
    return [];
  }
}
