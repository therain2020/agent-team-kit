import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  type InstalledSource,
  type RawSourceItem,
  SOURCE_TOPIC,
  type SourceCandidate,
  type SourceDefinition,
  type SourceMeta,
  sourceDefinitionSchema,
} from "./types";

const USER_AGENT = "agent-team-kit/0.1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const CACHE_MS = 60_000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BUILTIN_NAMES = new Set(["hn", "arxiv", "github"]);

const searchCache = new Map<
  string,
  { expiresAt: number; candidates: SourceCandidate[] }
>();

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
  } = {},
): Promise<SourceCandidate[]> {
  const topic = options.topic ?? SOURCE_TOPIC;
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 30);
  const query = [topic ? `topic:${topic}` : "", options.query ?? ""]
    .filter(Boolean)
    .join(" ");
  const cacheKey = `${query}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query || "agent-team-source",
  )}&sort=stars&order=desc&per_page=${limit}`;
  const payload = await githubJson<{
    items?: Array<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      default_branch: string;
      updated_at: string;
      topics?: string[];
    }>;
  }>(url, options.token);

  const repos = payload.items ?? [];
  const candidates = await Promise.all(
    repos.map(async (repo) => {
      const candidate: SourceCandidate = {
        repo: repo.full_name,
        htmlUrl: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        topics: repo.topics ?? [],
        updatedAt: repo.updated_at,
      };
      try {
        const raw = await fetchRawFile(
          repo.full_name,
          repo.default_branch,
          "source.yaml",
          options.token,
        );
        const parsed = sourceDefinitionSchema.safeParse(parse(raw));
        if (parsed.success) {
          candidate.manifest = parsed.data;
        } else {
          candidate.manifestError = parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
        }
      } catch (error) {
        candidate.manifestError =
          error instanceof Error ? error.message : String(error);
      }
      return candidate;
    }),
  );

  searchCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_MS,
    candidates,
  });
  return candidates;
}

export async function installSource(input: {
  repo: string;
  ref?: string;
  file?: string;
  token?: string;
  root?: string;
  acceptThirdParty: boolean;
}): Promise<InstalledSource> {
  if (!input.acceptThirdParty) {
    throw new Error("third-party sources require explicit confirmation");
  }
  if (!REPO_PATTERN.test(input.repo)) {
    throw new Error("repo must be owner/name");
  }
  const file = input.file ?? "source.yaml";
  if (file.includes("..") || file.startsWith("/")) {
    throw new Error("invalid manifest path");
  }

  const ref = input.ref || (await defaultBranch(input.repo, input.token));
  const commit = await resolveCommit(input.repo, ref, input.token);
  const raw = await fetchRawFile(input.repo, commit, file, input.token);
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("source.yaml exceeds 64KB");
  }

  const parsed = sourceDefinitionSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  const definition = parsed.data;
  if (BUILTIN_NAMES.has(definition.metadata.name)) {
    throw new Error(
      `source name is reserved by a builtin: ${definition.metadata.name}`,
    );
  }
  const { validateSourceEndpoint } = await import("./adapters");
  await validateSourceEndpoint(definition.spec.request.url);

  const root = getSourcesRoot(input.root);
  await mkdir(root, { recursive: true });
  const target = path.join(root, `${definition.metadata.name}.yaml`);
  const metaPath = path.join(root, `${definition.metadata.name}.meta.json`);
  const meta: SourceMeta = {
    name: definition.metadata.name,
    repo: input.repo,
    commit,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    installedAt: new Date().toISOString(),
    trust: "third-party",
    homepage: definition.metadata.homepage,
    license: definition.metadata.license,
  };

  await atomicWrite(target, raw);
  await atomicWrite(metaPath, JSON.stringify(meta, null, 2));
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
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
  const meta = existsSync(metaPath)
    ? (JSON.parse(await readFile(metaPath, "utf8")) as SourceMeta)
    : {
        name,
        repo: "local",
        commit: "working-tree",
        manifestSha256: createHash("sha256").update(raw).digest("hex"),
        installedAt: new Date(0).toISOString(),
        trust: "third-party" as const,
      };
  return { definition: parsed.data, meta, file: manifestPath };
}

export async function removeSource(name: string, root?: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || BUILTIN_NAMES.has(name)) {
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
  const { fetchFromDefinition } = await import("./adapters");
  const items = await fetchFromDefinition(
    installed.definition,
    options.limit ?? 3,
  );
  return { items };
}

async function defaultBranch(repo: string, token?: string): Promise<string> {
  const payload = await githubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${repo}`,
    token,
  );
  if (!payload.default_branch) {
    throw new Error(`cannot resolve default branch for ${repo}`);
  }
  return payload.default_branch;
}

async function resolveCommit(
  repo: string,
  ref: string,
  token?: string,
): Promise<string> {
  const payload = await githubJson<{ sha?: string }>(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    token,
  );
  if (!payload.sha || !/^[a-f0-9]{40}$/i.test(payload.sha)) {
    throw new Error(`cannot resolve commit for ${repo}@${ref}`);
  }
  return payload.sha;
}

async function fetchRawFile(
  repo: string,
  ref: string,
  file: string,
  token?: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`manifest ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function githubJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      "GitHub API rate limit exceeded; set GITHUB_TOKEN to raise the limit",
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}
