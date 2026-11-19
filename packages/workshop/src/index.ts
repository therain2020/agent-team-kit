import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PackTool,
  type WorkshopManifest,
  skillPackSchema,
  toolPackSchema,
  workshopManifestSchema,
} from "@kit/core";
import {
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_TOTAL_BYTES,
  assertRepo,
  commitStagedDir,
  createMarketSearchCache,
  defaultBranch,
  fetchRawFile,
  resolveCommit,
  searchMarket,
  sha256Hex,
  writeFileAtomic,
} from "@kit/market";
import { loadPack } from "@kit/pack";
import { parse } from "yaml";
import { WORKSHOP_TOPIC } from "./publish";
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
export * from "./components";
export * from "./publish";
export * from "./security";
export * from "./trust";

const WORKSHOP_KINDS = [
  "pack",
  "workflow",
  "agent",
  "toolpack",
  "skillpack",
  "pipeline",
  "source",
  "template",
] as const;

const searchCache = createMarketSearchCache<WorkshopManifest>();

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
  scope: WorkshopInstallScope;
  manifest: WorkshopManifest;
  manifestSha256: string;
  files: string[];
  trust: WorkshopTrust;
  permissions: WorkshopPermissionSummary;
}

/**
 * Destination family for an install: pack-kind items land under packs/ so the
 * console pack library can load, simulate and open them in Studio; everything
 * else stays under workshop/.
 */
export type WorkshopInstallScope = "packs" | "workshop";

export interface WorkshopInstallTarget {
  scope: WorkshopInstallScope;
  root: string;
  dir: string;
}

export interface WorkshopPackImport {
  id: string;
  dirName: string;
  dir: string;
  repo: string;
  commit: string;
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

export function workshopRoot(root?: string): string {
  return path.resolve(
    root ??
      process.env.KIT_WORKSHOP_ROOT ??
      path.join(process.cwd(), "workshop"),
  );
}

export function packsRoot(root?: string): string {
  return path.resolve(
    root ?? process.env.KIT_PACKS_ROOT ?? path.join(process.cwd(), "packs"),
  );
}

/**
 * Pick the destination for an install from the manifest kind (plan 88 §3.4).
 * Pack-kind items belong in the pack library, so they install as
 * `packs/<manifest.id>`; every other kind stays in the workshop directory.
 */
export function resolveInstallTarget(
  manifest: Pick<WorkshopManifest, "id" | "kind">,
  options: { root?: string; packsRoot?: string } = {},
): WorkshopInstallTarget {
  const scope: WorkshopInstallScope =
    manifest.kind === "pack" ? "packs" : "workshop";
  const root =
    scope === "packs"
      ? packsRoot(options.packsRoot)
      : workshopRoot(options.root);
  const dir = path.join(root, manifest.id);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (dir === root || !dir.startsWith(prefix)) {
    throw new Error("invalid workshop target");
  }
  return { scope, root, dir };
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
  const keys = options.keys ?? (await loadTrustedKeysOrEmpty());
  const results = await searchMarket<WorkshopManifest>({
    topic: options.topic ?? WORKSHOP_TOPIC,
    manifestFile: "workshop.yaml",
    query: options.query,
    limit: options.limit,
    token: options.token,
    cache: searchCache,
    parse: (raw) => {
      const parsed = workshopManifestSchema.safeParse(parse(raw));
      if (parsed.success) {
        return { manifest: parsed.data };
      }
      return {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
    },
  });

  return results.map((candidate) => {
    const mapped: WorkshopCandidate = {
      repo: candidate.repo,
      htmlUrl: candidate.htmlUrl,
      description: candidate.description,
      stars: candidate.stars,
      updatedAt: candidate.updatedAt,
    };
    if (candidate.manifest) {
      mapped.manifest = candidate.manifest;
      mapped.trust = verifyWorkshopSignature(candidate.manifest, keys);
    }
    if (candidate.manifestError) {
      mapped.manifestError = candidate.manifestError;
    }
    return mapped;
  });
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
    input.ref ?? (await defaultBranch(input.repo, { token: input.token })),
    { token: input.token },
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
  /** Workshop directory for non-pack kinds. */
  root?: string;
  /** Pack directory for `kind: pack` items. */
  packsRoot?: string;
  /** Replace an existing target directory instead of refusing. */
  overwrite?: boolean;
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
    input.ref ?? (await defaultBranch(input.repo, { token: input.token })),
    { token: input.token },
  );
  const { manifest, raw } = await fetchManifest(
    input.repo,
    commit,
    input.token,
  );
  const manifestSha256 = sha256Hex(JSON.stringify(manifest));
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

  const target = resolveInstallTarget(manifest, {
    root: input.root,
    packsRoot: input.packsRoot,
  });
  if (existsSync(target.dir) && input.overwrite !== true) {
    throw new Error(
      `install target already exists: ${target.scope}/${manifest.id}; pass overwrite to replace it`,
    );
  }

  // Stage the whole install next to the target, validate it there and only
  // then swap it into place. A failure never leaves a partial install and an
  // overwrite never destroys the previous copy until the new one is ready.
  const staging = path.join(
    target.root,
    `.${manifest.id}.installing-${randomUUID()}`,
  );
  await mkdir(staging, { recursive: true });

  const files: string[] = [];
  const hashes: Record<string, string> = {};
  try {
    for (const { file, content } of contents) {
      const destination = path.resolve(staging, file);
      if (!destination.startsWith(`${staging}${path.sep}`)) {
        throw new Error(`unsafe workshop path: ${file}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      files.push(file);
      hashes[file] = sha256Hex(content);
    }

    if (manifest.kind === "pack") {
      const loaded = await loadPack(staging);
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
        parse(await readFile(path.join(staging, manifest.entry), "utf8")),
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
        parse(await readFile(path.join(staging, manifest.entry), "utf8")),
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
        if (!existsSync(path.join(staging, file))) {
          throw new Error(`skillpack file is missing: ${file}`);
        }
      }
    }

    await writeFile(
      path.join(staging, ".workshop.json"),
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
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await commitStagedDir({
    staging,
    target: target.dir,
    id: manifest.id,
  });

  return {
    repo: input.repo,
    commit,
    dir: target.dir,
    scope: target.scope,
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

/**
 * Import a pack that was installed into the legacy `workshop/` directory as a
 * normal pack under `packs/`. Only pack-kind installs qualify. The import is an
 * explicit, staged copy: the source directory is left untouched (no silent
 * move), an existing destination is refused unless `overwrite` is set, and the
 * copy is validated with `loadPack` before it is swapped into place.
 */
export async function importInstalledPack(input: {
  dirName: string;
  root?: string;
  packsRoot?: string;
  overwrite?: boolean;
}): Promise<WorkshopPackImport> {
  const { dirName } = input;
  if (
    !dirName ||
    path.basename(dirName) !== dirName ||
    dirName.startsWith(".")
  ) {
    throw new Error("invalid workshop install name");
  }
  const source = path.join(workshopRoot(input.root), dirName);
  const recordPath = path.join(source, ".workshop.json");
  if (!existsSync(recordPath)) {
    throw new Error(`workshop install not found: ${dirName}`);
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(`workshop install record is not valid JSON: ${dirName}`);
  }
  if (record.kind !== "pack") {
    throw new Error(
      `only pack installs can be imported into packs/: ${dirName}`,
    );
  }
  const id = typeof record.id === "string" ? record.id : dirName;
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`invalid pack id in workshop record: ${id}`);
  }

  const root = packsRoot(input.packsRoot);
  const target = path.join(root, id);
  if (existsSync(target) && input.overwrite !== true) {
    throw new Error(`packs/${id} already exists; pass overwrite to replace it`);
  }
  await mkdir(root, { recursive: true });

  const staging = path.join(root, `.${id}.importing-${randomUUID()}`);
  try {
    await cp(source, staging, { recursive: true });
    const loaded = await loadPack(staging);
    if (!loaded.ok) {
      throw new Error(`imported pack is invalid: ${loaded.errors.join("; ")}`);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await commitStagedDir({ staging, target, id });

  return {
    id,
    dirName: id,
    dir: target,
    repo: typeof record.repo === "string" ? record.repo : "",
    commit: typeof record.commit === "string" ? record.commit : "",
  };
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
  const raw = await fetchRawFile(repo, ref, "workshop.yaml", { token });
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
    const content = await fetchRawFile(repo, ref, file, { token });
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
