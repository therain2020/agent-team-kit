import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PackTool,
  type WorkshopManifest,
  skillPackSchema,
  toolPackSchema,
  workshopManifestSchema,
} from "@kit/core";
import { loadPack, scanSecrets } from "@kit/pack";
import { parse } from "yaml";

const USER_AGENT = "agent-team-kit/0.9";
const WORKSHOP_TOPIC = "agent-team-workshop";
const CACHE_MS = 60_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const searchCache = new Map<
  string,
  { expiresAt: number; candidates: WorkshopCandidate[] }
>();

export interface WorkshopCandidate {
  repo: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  updatedAt: string;
  manifest?: WorkshopManifest;
  manifestError?: string;
}

export interface WorkshopPreview {
  repo: string;
  commit: string;
  manifest: WorkshopManifest;
  entryPreview: string;
}

export interface WorkshopInstall {
  repo: string;
  commit: string;
  dir: string;
  manifest: WorkshopManifest;
  files: string[];
}

export function workshopRoot(root?: string): string {
  return path.resolve(
    root ??
      process.env.KIT_WORKSHOP_ROOT ??
      path.join(process.cwd(), "workshop"),
  );
}

export async function searchWorkshop(
  options: {
    query?: string;
    topic?: string;
    limit?: number;
    token?: string;
  } = {},
): Promise<WorkshopCandidate[]> {
  const topic = options.topic ?? WORKSHOP_TOPIC;
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 30);
  const query = [`topic:${topic}`, options.query ?? ""]
    .filter(Boolean)
    .join(" ");
  const cacheKey = `${query}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=stars&order=desc&per_page=${limit}`;
  const payload = await githubJson<{
    items?: Array<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      default_branch: string;
      updated_at: string;
    }>;
  }>(url, options.token);

  const candidates = await Promise.all(
    (payload.items ?? []).map(async (repo) => {
      const candidate: WorkshopCandidate = {
        repo: repo.full_name,
        htmlUrl: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        updatedAt: repo.updated_at,
      };
      try {
        const raw = await fetchRaw(
          repo.full_name,
          repo.default_branch,
          "workshop.yaml",
          options.token,
        );
        const parsed = workshopManifestSchema.safeParse(parse(raw));
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

export async function previewWorkshop(input: {
  repo: string;
  ref?: string;
  token?: string;
}): Promise<WorkshopPreview> {
  assertRepo(input.repo);
  const commit = await resolveCommit(
    input.repo,
    input.ref ?? (await defaultBranch(input.repo, input.token)),
    input.token,
  );
  const manifest = await fetchManifest(input.repo, commit, input.token);
  const entryPreview = (
    await fetchRaw(input.repo, commit, manifest.entry, input.token)
  ).slice(0, 4096);
  return { repo: input.repo, commit, manifest, entryPreview };
}

export async function installWorkshop(input: {
  repo: string;
  ref?: string;
  token?: string;
  root?: string;
  acceptThirdParty: boolean;
  allowCode?: boolean;
}): Promise<WorkshopInstall> {
  assertRepo(input.repo);
  if (!input.acceptThirdParty) {
    throw new Error("third-party workshop items require explicit confirmation");
  }
  const commit = await resolveCommit(
    input.repo,
    input.ref ?? (await defaultBranch(input.repo, input.token)),
    input.token,
  );
  const manifest = await fetchManifest(input.repo, commit, input.token);
  if (manifest.permissions.code && !input.allowCode) {
    throw new Error(
      "workshop item contains code; pass allowCode to install it",
    );
  }
  if (manifest.files.length > 200) {
    throw new Error("workshop item has too many files");
  }

  const target = path.join(workshopRoot(input.root), manifest.id);
  if (
    !target.startsWith(`${workshopRoot(input.root)}${path.sep}`) ||
    target === workshopRoot(input.root)
  ) {
    throw new Error("invalid workshop target");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const files: string[] = [];
  const hashes: Record<string, string> = {};
  let total = 0;
  try {
    for (const file of manifest.files) {
      const content = await fetchRaw(input.repo, commit, file, input.token);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(`file exceeds 256KB: ${file}`);
      }
      total += bytes;
      if (total > MAX_TOTAL_BYTES) {
        throw new Error("workshop item exceeds 5MB");
      }
      const secretErrors: string[] = [];
      scanSecrets(content, file, secretErrors);
      if (secretErrors.length > 0) {
        throw new Error(secretErrors.join("; "));
      }
      const destination = path.resolve(target, file);
      if (!destination.startsWith(`${target}${path.sep}`)) {
        throw new Error(`unsafe workshop path: ${file}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      files.push(file);
      hashes[file] = createHash("sha256").update(content).digest("hex");
    }

    if (manifest.kind === "pack") {
      const loaded = await loadPack(target);
      if (!loaded.ok) {
        throw new Error(
          `installed pack is invalid: ${loaded.errors.join("; ")}`,
        );
      }
      assertToolPermissions(
        loaded.toolPacks.flatMap((toolPack) => toolPack.tools),
        manifest,
      );
    } else if (manifest.kind === "toolpack") {
      const parsed = toolPackSchema.safeParse(
        parse(await readFile(path.join(target, manifest.entry), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(
          `installed toolpack is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      assertToolPermissions(parsed.data.tools, manifest);
    } else if (manifest.kind === "skillpack") {
      const parsed = skillPackSchema.safeParse(
        parse(await readFile(path.join(target, manifest.entry), "utf8")),
      );
      if (!parsed.success) {
        throw new Error(
          `installed skillpack is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      for (const file of parsed.data.files) {
        if (!manifest.files.includes(file)) {
          throw new Error(
            `skillpack file is not listed in the manifest: ${file}`,
          );
        }
        if (!existsSync(path.join(target, file))) {
          throw new Error(`skillpack file is missing: ${file}`);
        }
      }
    }

    await writeFile(
      path.join(target, ".workshop.json"),
      JSON.stringify(
        {
          repo: input.repo,
          commit,
          manifestSha256: createHash("sha256")
            .update(JSON.stringify(manifest))
            .digest("hex"),
          files: hashes,
          installedAt: new Date().toISOString(),
          permissions: manifest.permissions,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }

  return { repo: input.repo, commit, dir: target, manifest, files };
}

async function fetchManifest(
  repo: string,
  ref: string,
  token?: string,
): Promise<WorkshopManifest> {
  const raw = await fetchRaw(repo, ref, "workshop.yaml", token);
  const secretErrors: string[] = [];
  scanSecrets(raw, "workshop.yaml", secretErrors);
  if (secretErrors.length > 0) {
    throw new Error(secretErrors.join("; "));
  }
  const parsed = workshopManifestSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  return parsed.data;
}

function assertRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error("repo must be owner/name");
  }
}

function assertToolPermissions(
  tools: PackTool[],
  manifest: WorkshopManifest,
): void {
  for (const tool of tools) {
    if (tool.adapter === "command" && !manifest.permissions.code) {
      throw new Error(`tool ${tool.name} requires manifest permissions.code`);
    }
    if (
      (tool.adapter === "http" || tool.adapter === "mcp") &&
      !manifest.permissions.network
    ) {
      throw new Error(
        `tool ${tool.name} requires manifest permissions.network`,
      );
    }
  }
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

async function fetchRaw(
  repo: string,
  ref: string,
  file: string,
  token?: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `raw file ${response.status} ${response.statusText}: ${file}`,
    );
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
    signal: AbortSignal.timeout(20_000),
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
