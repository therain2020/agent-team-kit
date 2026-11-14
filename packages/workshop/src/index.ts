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
import {
  type PackTool,
  type WorkshopManifest,
  skillPackSchema,
  teamPackSchema,
  toolPackSchema,
  workshopManifestSchema,
} from "@kit/core";
import { loadPack } from "@kit/pack";
import { parse, stringify } from "yaml";
import {
  type WorkshopFileContent,
  type WorkshopPermissionSummary,
  type WorkshopSecretFinding,
  scanWorkshopSecrets,
  summarizeWorkshopPermissions,
} from "./security";
import {
  type WorkshopTrust,
  type WorkshopTrustedKey,
  loadWorkshopTrustedKeys,
  verifyWorkshopSignature,
} from "./trust";

export type { WorkshopManifest } from "@kit/core";
export * from "./security";
export * from "./trust";

const USER_AGENT = "agent-team-kit/0.9";
const WORKSHOP_TOPIC = "agent-team-workshop";
const CACHE_MS = 60_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKSHOP_KINDS = [
  "pack",
  "workflow",
  "agent",
  "toolpack",
  "skillpack",
] as const;
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".tmp",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const IGNORED_FILES = new Set(["workshop.yaml", ".workshop.json"]);
const CODE_FILE =
  /\.(?:sh|ps1|bat|cmd|js|mjs|cjs|ts|tsx|py|rb|go|rs|java|jar|exe|dll|so|dylib)$/i;
const CODE_ADAPTER =
  /(?:adapter\s*:\s*["']?command\b|["']adapter["']\s*:\s*["']command\b)/i;

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
  trust?: WorkshopTrust;
}

export interface WorkshopPreview {
  repo: string;
  commit: string;
  manifest: WorkshopManifest;
  entryPreview: string;
  trust: WorkshopTrust;
  permissions: WorkshopPermissionSummary;
  secretFindings: WorkshopSecretFinding[];
}

export interface WorkshopInstall {
  repo: string;
  commit: string;
  dir: string;
  manifest: WorkshopManifest;
  manifestSha256: string;
  files: string[];
  trust: WorkshopTrust;
  permissions: WorkshopPermissionSummary;
}

export interface WorkshopInstallRecord {
  dirName: string;
  kind: WorkshopManifest["kind"] | "unknown";
  id: string;
  name: string;
  version: string;
  entry: string;
  license: string;
  repo: string;
  commit: string;
  manifestSha256: string;
  installedAt: string;
  permissions: WorkshopManifest["permissions"];
  fileCount: number;
  trust: WorkshopTrust;
  manifest: Pick<
    WorkshopManifest,
    "id" | "name" | "version" | "kind" | "description"
  > | null;
}

export interface WorkshopPublishFile {
  path: string;
  bytes: number;
  sha256: string;
}

export type WorkshopCheckStatus = "pass" | "warn" | "fail";

export interface WorkshopPublishCheck {
  id: string;
  status: WorkshopCheckStatus;
  detail: string;
}

export interface WorkshopRisk {
  level: "low" | "medium" | "high";
  reasons: string[];
}

export interface WorkshopPublishResult {
  dir: string;
  manifestPath: string;
  manifest: WorkshopManifest;
  generated: boolean;
  written: boolean;
  files: WorkshopPublishFile[];
  permissions: WorkshopManifest["permissions"];
  risk: WorkshopRisk;
  checks: WorkshopPublishCheck[];
  ok: boolean;
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
    keys?: WorkshopTrustedKey[];
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

  const keys = options.keys ?? (await loadTrustedKeysOrEmpty());
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
          candidate.trust = verifyWorkshopSignature(parsed.data, keys);
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
  keys?: WorkshopTrustedKey[];
}): Promise<WorkshopPreview> {
  assertRepo(input.repo);
  const keys = input.keys ?? (await loadWorkshopTrustedKeys());
  const commit = await resolveCommit(
    input.repo,
    input.ref ?? (await defaultBranch(input.repo, input.token)),
    input.token,
  );
  const { manifest, raw } = await fetchManifest(
    input.repo,
    commit,
    input.token,
  );
  const contents = await fetchWorkshopFiles(
    input.repo,
    commit,
    manifest,
    input.token,
  );
  const entryPreview = (
    contents.find((file) => file.file === manifest.entry)?.content ?? ""
  ).slice(0, 4096);

  return {
    repo: input.repo,
    commit,
    manifest,
    entryPreview,
    trust: verifyWorkshopSignature(manifest, keys),
    permissions: summarizeWorkshopPermissions(manifest),
    secretFindings: scanWorkshopSecrets([
      { file: "workshop.yaml", content: raw },
      ...contents,
    ]),
  };
}

export async function installWorkshop(input: {
  repo: string;
  ref?: string;
  token?: string;
  root?: string;
  acceptThirdParty: boolean;
  allowCode?: boolean;
  acceptUnsigned?: boolean;
  acceptHighRisk?: boolean;
  keys?: WorkshopTrustedKey[];
}): Promise<WorkshopInstall> {
  assertRepo(input.repo);
  if (!input.acceptThirdParty) {
    throw new Error("third-party workshop items require explicit confirmation");
  }
  const keys = input.keys ?? (await loadWorkshopTrustedKeys());
  const commit = await resolveCommit(
    input.repo,
    input.ref ?? (await defaultBranch(input.repo, input.token)),
    input.token,
  );
  const { manifest, raw } = await fetchManifest(
    input.repo,
    commit,
    input.token,
  );
  const manifestSha256 = sha256(JSON.stringify(manifest));
  const trust = verifyWorkshopSignature(manifest, keys);
  if (trust.level === "community" && input.acceptUnsigned !== true) {
    throw new Error(
      "workshop item is unsigned or its signature cannot be verified; pass acceptUnsigned to install it",
    );
  }
  if (manifest.permissions.code && !input.allowCode) {
    throw new Error(
      "workshop item contains code; pass allowCode to install it",
    );
  }
  const permissions = summarizeWorkshopPermissions(manifest);
  if (permissions.highRisk.length > 0 && input.acceptHighRisk !== true) {
    throw new Error(
      `workshop item requests high-risk permissions (${permissions.highRisk
        .map((entry) => entry.id)
        .join(", ")}); pass acceptHighRisk to install it`,
    );
  }

  const contents = await fetchWorkshopFiles(
    input.repo,
    commit,
    manifest,
    input.token,
  );
  const secretFindings = scanWorkshopSecrets([
    { file: "workshop.yaml", content: raw },
    ...contents,
  ]);
  if (secretFindings.length > 0) {
    throw new Error(
      `workshop item contains secret-like content: ${secretFindings
        .map((finding) => `${finding.file}:${finding.line} (${finding.label})`)
        .join("; ")}`,
    );
  }

  const root = workshopRoot(input.root);
  const target = path.join(root, manifest.id);
  if (!target.startsWith(`${root}${path.sep}`) || target === root) {
    throw new Error("invalid workshop target");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  const files: string[] = [];
  const hashes: Record<string, string> = {};
  try {
    for (const { file, content } of contents) {
      const destination = path.resolve(target, file);
      if (!destination.startsWith(`${target}${path.sep}`)) {
        throw new Error(`unsafe workshop path: ${file}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      files.push(file);
      hashes[file] = sha256(content);
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
          kind: manifest.kind,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          entry: manifest.entry,
          license: manifest.license,
          topics: manifest.topics,
          repo: input.repo,
          commit,
          manifestSha256,
          manifest: {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            kind: manifest.kind,
            description: manifest.description,
          },
          files: hashes,
          installedAt: new Date().toISOString(),
          permissions: manifest.permissions,
          trust,
          secretScan: "passed",
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

  return {
    repo: input.repo,
    commit,
    dir: target,
    manifest,
    manifestSha256,
    files,
    trust,
    permissions,
  };
}

export async function listInstalledWorkshop(
  root?: string,
): Promise<WorkshopInstallRecord[]> {
  const base = workshopRoot(root);
  if (!existsSync(base)) {
    return [];
  }

  const entries = await readdir(base, { withFileTypes: true });
  const records: WorkshopInstallRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const recordPath = path.join(base, entry.name, ".workshop.json");
    if (!existsSync(recordPath)) {
      continue;
    }
    try {
      const raw = JSON.parse(await readFile(recordPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (typeof raw.repo !== "string" || typeof raw.commit !== "string") {
        continue;
      }
      const rawFiles = raw.files;
      records.push({
        dirName: entry.name,
        kind: parseKind(raw.kind),
        id: typeof raw.id === "string" ? raw.id : entry.name,
        name: typeof raw.name === "string" ? raw.name : entry.name,
        version: typeof raw.version === "string" ? raw.version : "0.0.0",
        entry: typeof raw.entry === "string" ? raw.entry : "",
        license: typeof raw.license === "string" ? raw.license : "",
        repo: raw.repo,
        commit: raw.commit,
        manifestSha256:
          typeof raw.manifestSha256 === "string" ? raw.manifestSha256 : "",
        installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
        permissions: normalizePermissions(raw.permissions),
        fileCount:
          rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles)
            ? Object.keys(rawFiles).length
            : 0,
        trust: normalizeTrust(raw.trust),
        manifest: normalizeManifestSummary(raw.manifest),
      });
    } catch {
      // corrupt install records stay on disk but are skipped by the console
    }
  }

  return records.sort(
    (a, b) =>
      b.installedAt.localeCompare(a.installedAt) ||
      a.name.localeCompare(b.name),
  );
}

export async function publishWorkshop(
  input: { dir?: string; write?: boolean } = {},
): Promise<WorkshopPublishResult> {
  const dir = path.resolve(input.dir ?? process.cwd());
  if (!existsSync(dir)) {
    throw new Error(`workshop directory not found: ${dir}`);
  }

  const manifestPath = path.join(dir, "workshop.yaml");
  const checks: WorkshopPublishCheck[] = [];
  let manifest: WorkshopManifest;
  let generated = false;
  let written = false;

  if (existsSync(manifestPath)) {
    const raw = await readFile(manifestPath, "utf8");
    let data: unknown;
    try {
      data = parse(raw);
    } catch (error) {
      throw new Error(
        `workshop.yaml parse error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = workshopManifestSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(
        `invalid workshop.yaml: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    manifest = parsed.data;
    checks.push(check("manifest", "pass", "workshop.yaml is valid"));
  } else {
    manifest = await generateManifest(dir, await collectWorkshopFiles(dir));
    generated = true;
    checks.push(
      check("manifest", "pass", "workshop.yaml generated from team.yaml"),
    );
  }

  if (manifest.files.includes(manifest.entry)) {
    checks.push(check("entry", "pass", `entry ${manifest.entry} is listed`));
  } else {
    checks.push(check("entry", "fail", "entry must be listed in files"));
  }

  const files: WorkshopPublishFile[] = [];
  const missing: string[] = [];
  const oversize: string[] = [];
  let total = 0;
  for (const file of manifest.files) {
    let absolute: string;
    try {
      absolute = safeJoin(dir, file);
    } catch {
      checks.push(check(`path:${file}`, "fail", `unsafe path: ${file}`));
      continue;
    }
    if (!existsSync(absolute)) {
      missing.push(file);
      continue;
    }
    const content = await readFile(absolute);
    if (!isTextContent(content)) {
      checks.push(
        check(`text:${file}`, "fail", `binary file is not supported: ${file}`),
      );
      continue;
    }
    if (content.length > MAX_FILE_BYTES) {
      oversize.push(`${file} (${content.length} bytes)`);
    }
    total += content.length;
    files.push({ path: file, bytes: content.length, sha256: sha256(content) });
  }

  if (missing.length === 0) {
    checks.push(check("files", "pass", `${files.length} declared files found`));
  } else {
    checks.push(check("files", "fail", `missing files: ${missing.join(", ")}`));
  }
  if (oversize.length > 0) {
    checks.push(
      check("file-size", "fail", `files exceed 256KB: ${oversize.join(", ")}`),
    );
  }
  if (total > MAX_TOTAL_BYTES) {
    checks.push(
      check("total-size", "fail", `declared files exceed 5MB (${total} bytes)`),
    );
  } else {
    checks.push(
      check("size", "pass", `${total} bytes across ${files.length} files`),
    );
  }

  const localFiles = await collectWorkshopFiles(dir);
  const undeclared = localFiles.filter(
    (file) => !manifest.files.includes(file),
  );
  if (undeclared.length > 0) {
    checks.push(
      check(
        "undeclared",
        "warn",
        `not published (not listed in files): ${undeclared.slice(0, 8).join(", ")}${
          undeclared.length > 8 ? "…" : ""
        }`,
      ),
    );
  } else {
    checks.push(check("undeclared", "pass", "all local files are declared"));
  }

  const detection = await detectCode(
    dir,
    files.map((file) => file.path),
  );
  if (detection.code && !manifest.permissions.code) {
    checks.push(
      check(
        "code",
        "fail",
        "executable code detected but permissions.code is false",
      ),
    );
  } else if (detection.code) {
    checks.push(
      check(
        "code",
        "warn",
        `executable code: ${detection.reasons.slice(0, 4).join("; ")} — installation requires explicit code consent`,
      ),
    );
  } else {
    checks.push(check("code", "pass", "no executable code detected"));
  }

  if (
    manifest.files.some((file) =>
      /^readme(?:\.md)?$/i.test(path.basename(file)),
    )
  ) {
    checks.push(check("readme", "pass", "README present"));
  } else {
    checks.push(
      check("readme", "warn", "add a README.md so the item is discoverable"),
    );
  }
  if (manifest.license) {
    checks.push(check("license", "pass", `license ${manifest.license}`));
  } else {
    checks.push(check("license", "warn", "add a license to workshop.yaml"));
  }
  if (manifest.topics.includes(WORKSHOP_TOPIC)) {
    checks.push(check("topic", "pass", `topic ${WORKSHOP_TOPIC} declared`));
  } else {
    checks.push(
      check(
        "topic",
        "warn",
        `add the GitHub topic ${WORKSHOP_TOPIC} to the repository`,
      ),
    );
  }

  if (manifest.kind === "pack" && missing.length === 0) {
    const loaded = await loadPack(dir);
    checks.push(
      loaded.ok
        ? check("pack", "pass", "pack loads and validates")
        : check("pack", "fail", `pack is invalid: ${loaded.errors.join("; ")}`),
    );
  }

  const ok = checks.every((item) => item.status !== "fail");
  if (generated && input.write !== false && ok) {
    await writeFileAtomic(manifestPath, stringify(manifest));
    written = true;
  }

  return {
    dir,
    manifestPath,
    manifest,
    generated,
    written,
    files,
    permissions: manifest.permissions,
    risk: summarizeRisk(manifest),
    checks,
    ok,
  };
}

async function generateManifest(
  dir: string,
  files: string[],
): Promise<WorkshopManifest> {
  const teamPath = path.join(dir, "team.yaml");
  if (!existsSync(teamPath)) {
    throw new Error(
      "publish needs team.yaml (pack) or an existing workshop.yaml",
    );
  }
  const team = teamPackSchema.safeParse(
    parse(await readFile(teamPath, "utf8")),
  );
  if (!team.success) {
    throw new Error(
      `team.yaml is invalid: ${team.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const metadata = team.data.metadata;
  const id = metadata.name.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `cannot derive a workshop id from pack name "${metadata.name}"`,
    );
  }

  const detection = await detectCode(dir, files);
  const payload: Record<string, unknown> = {
    apiVersion: "agentteam/v1",
    kind: "pack",
    id,
    name: metadata.name,
    version: metadata.version,
    description: metadata.description ?? "",
    entry: "team.yaml",
    files,
    topics: [WORKSHOP_TOPIC],
    permissions: {
      network: false,
      filesystem: "workspace",
      code: detection.code,
    },
  };
  if (metadata.license) {
    payload.license = metadata.license;
  }
  if (metadata.compatibility) {
    payload.compatibility = metadata.compatibility;
  }

  const parsed = workshopManifestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `generated manifest is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

async function collectWorkshopFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(relative)) {
          continue;
        }
        files.push(relative);
      }
    }
  }

  await walk(dir, "");
  return files.sort();
}

async function detectCode(
  dir: string,
  files: string[],
): Promise<{ code: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  for (const file of files) {
    if (CODE_FILE.test(file)) {
      reasons.push(`executable file: ${file}`);
      continue;
    }
    if (!/\.(?:ya?ml|json)$/i.test(file)) {
      continue;
    }
    try {
      const text = await readFile(safeJoin(dir, file), "utf8");
      if (CODE_ADAPTER.test(text)) {
        reasons.push(`command adapter: ${file}`);
      }
    } catch {
      // unreadable files are reported by the file checks
    }
  }
  return { code: reasons.length > 0, reasons };
}

function summarizeRisk(manifest: WorkshopManifest): WorkshopRisk {
  const reasons: string[] = [];
  if (manifest.permissions.code) {
    reasons.push("declares executable code");
  }
  if (manifest.permissions.network) {
    reasons.push("requests network access");
  }
  if (manifest.permissions.filesystem === "workspace") {
    reasons.push("can write inside the workspace");
  } else if (manifest.permissions.filesystem === "readonly") {
    reasons.push("read-only filesystem access");
  }
  if (reasons.length === 0) {
    reasons.push("declarative data only");
  }
  const level = manifest.permissions.code
    ? "high"
    : manifest.permissions.network || manifest.permissions.filesystem !== "none"
      ? "medium"
      : "low";
  return { level, reasons };
}

function check(
  id: string,
  status: WorkshopCheckStatus,
  detail: string,
): WorkshopPublishCheck {
  return { id, status, detail };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTextContent(content: Buffer): boolean {
  return !content.subarray(0, 8192).includes(0);
}

function safeJoin(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe workshop path: ${relative}`);
  }
  return resolved;
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function parseKind(value: unknown): WorkshopManifest["kind"] | "unknown" {
  return typeof value === "string" &&
    (WORKSHOP_KINDS as readonly string[]).includes(value)
    ? (value as WorkshopManifest["kind"])
    : "unknown";
}

function normalizePermissions(value: unknown): WorkshopManifest["permissions"] {
  const raw = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    network: raw.network === true,
    filesystem:
      raw.filesystem === "none" ||
      raw.filesystem === "readonly" ||
      raw.filesystem === "workspace"
        ? raw.filesystem
        : "workspace",
    code: raw.code === true,
  };
}

async function fetchManifest(
  repo: string,
  ref: string,
  token?: string,
): Promise<{ manifest: WorkshopManifest; raw: string }> {
  const raw = await fetchRaw(repo, ref, "workshop.yaml", token);
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("workshop.yaml exceeds 64KB");
  }
  const parsed = workshopManifestSchema.safeParse(parse(raw));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  return { manifest: parsed.data, raw };
}

async function fetchWorkshopFiles(
  repo: string,
  ref: string,
  manifest: WorkshopManifest,
  token?: string,
): Promise<WorkshopFileContent[]> {
  const files: WorkshopFileContent[] = [];
  let total = 0;
  for (const file of manifest.files) {
    const content = await fetchRaw(repo, ref, file, token);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`file exceeds 256KB: ${file}`);
    }
    total += bytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error("workshop item exceeds 5MB");
    }
    files.push({ file, content });
  }
  return files;
}

function normalizeTrust(value: unknown): WorkshopTrust {
  if (value && typeof value === "object") {
    const { level, signature, keyId } = value as Record<string, unknown>;
    const levels = ["builtin", "verified", "community"];
    const statuses = ["valid", "invalid", "unknown-key", "missing"];
    if (
      typeof level === "string" &&
      levels.includes(level) &&
      typeof signature === "string" &&
      statuses.includes(signature)
    ) {
      return {
        level: level as WorkshopTrust["level"],
        signature: signature as WorkshopTrust["signature"],
        ...(typeof keyId === "string" ? { keyId } : {}),
      };
    }
  }
  return { level: "community", signature: "missing" };
}

function normalizeManifestSummary(
  value: unknown,
): Pick<
  WorkshopManifest,
  "id" | "name" | "version" | "kind" | "description"
> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.version !== "string" ||
    typeof record.kind !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    kind: record.kind as WorkshopManifest["kind"],
    description:
      typeof record.description === "string" ? record.description : "",
  };
}

async function loadTrustedKeysOrEmpty(): Promise<WorkshopTrustedKey[]> {
  try {
    return await loadWorkshopTrustedKeys();
  } catch {
    return [];
  }
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
