import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PackTool,
  type PipelineNode,
  type PipelineSpec,
  type WorkflowDefinition,
  type WorkshopManifest,
  pipelineSpecSchema,
  skillPackSchema,
  sourceAssetSchema,
  templateDefinitionSchema,
  toolPackSchema,
  workflowDefinitionSchema,
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
  writeJsonAtomic,
} from "@kit/market";
import { getTemplatesRoot, loadPack } from "@kit/pack";
import { parse, stringify } from "yaml";
import { componentsRoot, loadComponentFromDir } from "./components";
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

const COMPONENT_INSTALL_KINDS = [
  "agent",
  "workflow",
  "toolpack",
  "skillpack",
] as const;

type ComponentInstallKind = (typeof COMPONENT_INSTALL_KINDS)[number];

function isComponentInstallKind(
  kind: WorkshopManifest["kind"],
): kind is ComponentInstallKind {
  return (COMPONENT_INSTALL_KINDS as readonly string[]).includes(kind);
}

/**
 * Destination family for an install, selected from `manifest.kind` (plan 88
 * §3.4). Every asset lands in its own local library; the legacy `workshop/`
 * directory is only read for pre-M3 installs.
 */
export type WorkshopInstallScope =
  | "packs"
  | "sources"
  | "templates"
  | "components"
  | "pack-workflows";

export interface WorkshopInstallTarget {
  scope: WorkshopInstallScope;
  /** Directory whose children are install targets. */
  root: string;
  /** Directory to swap into place, or the manifest file for file targets. */
  dir: string;
  /** Directory targets are staged + swapped; file targets are written in place. */
  format: "directory" | "file";
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

/** Installed source library (`source.yaml` + `<name>.meta.json`). */
export function sourcesRoot(root?: string): string {
  return path.resolve(
    root ?? process.env.KIT_SOURCES_ROOT ?? path.join(process.cwd(), "sources"),
  );
}

/** Template library; defaults follow `@kit/pack`'s template registry. */
export function templatesRoot(root?: string): string {
  return getTemplatesRoot(root);
}

export interface InstallTargetOptions {
  packsRoot?: string;
  sourcesRoot?: string;
  templatesRoot?: string;
  componentsRoot?: string;
  /** Host pack directory; required for `kind: pipeline` (plan 88 §3.4). */
  hostPack?: string;
}

function assertInside(root: string, target: string): void {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target === root || !target.startsWith(prefix)) {
    throw new Error("invalid workshop target");
  }
}

/**
 * Pick the destination for an install from the manifest kind (plan 88 §3.4):
 * pack → `packs/`, source → `sources/<name>.yaml`, template → `templates/`,
 * pipeline → the host pack's `workflows/`, components → `components/<kind>/`.
 */
export function resolveInstallTarget(
  manifest: Pick<WorkshopManifest, "id" | "kind">,
  options: InstallTargetOptions = {},
): WorkshopInstallTarget {
  const { id, kind } = manifest;
  if (kind === "pack") {
    const root = packsRoot(options.packsRoot);
    const dir = path.join(root, id);
    assertInside(root, dir);
    return { scope: "packs", root, dir, format: "directory" };
  }
  if (kind === "template") {
    const root = templatesRoot(options.templatesRoot);
    const dir = path.join(root, id);
    assertInside(root, dir);
    return { scope: "templates", root, dir, format: "directory" };
  }
  if (kind === "source") {
    const root = sourcesRoot(options.sourcesRoot);
    const dir = path.join(root, `${id}.yaml`);
    assertInside(root, dir);
    return { scope: "sources", root, dir, format: "file" };
  }
  if (kind === "pipeline") {
    if (!options.hostPack) {
      throw new Error(
        "pipeline installs require a host pack; pass the target pack directory (--host-pack)",
      );
    }
    const root = path.resolve(options.hostPack);
    const dir = path.join(root, "workflows", `${id}.yaml`);
    assertInside(root, dir);
    return { scope: "pack-workflows", root, dir, format: "file" };
  }
  if (!isComponentInstallKind(kind)) {
    throw new Error(`unsupported workshop kind: ${String(kind)}`);
  }
  const base = componentsRoot(options.componentsRoot);
  const root = path.join(base, kind);
  const dir = path.join(root, id);
  assertInside(base, dir);
  return { scope: "components", root, dir, format: "directory" };
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
  /** Pack directory for `kind: pack` items. */
  packsRoot?: string;
  /** Source library for `kind: source` items (default `./sources`). */
  sourcesRoot?: string;
  /** Template library for `kind: template` items. */
  templatesRoot?: string;
  /** Component library for agent/workflow/toolpack/skillpack items. */
  componentsRoot?: string;
  /** Host pack directory; required for `kind: pipeline` items. */
  hostPack?: string;
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
    packsRoot: input.packsRoot,
    sourcesRoot: input.sourcesRoot,
    templatesRoot: input.templatesRoot,
    componentsRoot: input.componentsRoot,
    hostPack: input.hostPack,
  });

  const files =
    target.format === "file"
      ? target.scope === "sources"
        ? await installSourceTarget({
            target,
            manifest,
            entryContent: entryContent(manifest, contents),
            repo: input.repo,
            commit,
            trust,
            overwrite: input.overwrite === true,
          })
        : await installPipelineTarget({
            target,
            manifest,
            entryContent: entryContent(manifest, contents),
            repo: input.repo,
            commit,
            manifestSha256,
            trust,
            overwrite: input.overwrite === true,
          })
      : await installDirectoryTarget({
          target,
          manifest,
          contents,
          repo: input.repo,
          commit,
          manifestSha256,
          trust,
          overwrite: input.overwrite === true,
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

function entryContent(
  manifest: WorkshopManifest,
  contents: WorkshopFileContent[],
): string {
  const entry = contents.find((file) => file.file === manifest.entry);
  if (!entry) {
    throw new Error(`workshop entry was not downloaded: ${manifest.entry}`);
  }
  return entry.content;
}

function installRecord(input: {
  manifest: WorkshopManifest;
  repo: string;
  commit: string;
  manifestSha256: string;
  files: Record<string, string>;
  trust: WorkshopTrust;
}): Record<string, unknown> {
  const { manifest } = input;
  // The entry file is the single source of truth for a component's version
  // (plan 88 §4 "文件唯一事实源"); copying the manifest version here would
  // turn harmless `1.0.0` vs `1.0` differences into lockfile mismatches.
  const component = isComponentInstallKind(manifest.kind);
  return {
    kind: manifest.kind,
    id: manifest.id,
    name: manifest.name,
    ...(component ? {} : { version: manifest.version }),
    entry: manifest.entry,
    license: manifest.license,
    topics: manifest.topics,
    repo: input.repo,
    commit: input.commit,
    manifestSha256: input.manifestSha256,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind,
      description: manifest.description,
    },
    files: input.files,
    installedAt: new Date().toISOString(),
    permissions: manifest.permissions,
    trust: input.trust,
    secretScan: "passed",
  };
}

async function installDirectoryTarget(input: {
  target: WorkshopInstallTarget;
  manifest: WorkshopManifest;
  contents: WorkshopFileContent[];
  repo: string;
  commit: string;
  manifestSha256: string;
  trust: WorkshopTrust;
  overwrite: boolean;
}): Promise<string[]> {
  const { target, manifest, contents } = input;
  if (existsSync(target.dir) && !input.overwrite) {
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

    const entry = await readFile(
      path.join(staging, manifest.entry),
      "utf8",
    ).catch(() => "");

    // The record is provenance, and for components its `entry` is what the
    // library loader reads; write it before validating so the staged directory
    // is judged in exactly the shape it will have after the swap.
    await writeFile(
      path.join(staging, ".workshop.json"),
      JSON.stringify(
        installRecord({
          manifest,
          repo: input.repo,
          commit: input.commit,
          manifestSha256: input.manifestSha256,
          files: hashes,
          trust: input.trust,
        }),
        null,
        2,
      ),
      "utf8",
    );

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
    } else if (manifest.kind === "template") {
      const parsed = templateDefinitionSchema.safeParse(parse(entry));
      if (!parsed.success) {
        throw new Error(
          `installed template is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      if (parsed.data.id !== manifest.id) {
        throw new Error(
          `installed template id "${parsed.data.id}" does not match manifest id "${manifest.id}"`,
        );
      }
    } else if (manifest.kind === "toolpack") {
      const parsed = toolPackSchema.safeParse(parse(entry));
      if (!parsed.success) {
        throw new Error(
          `installed toolpack is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      assertToolPermissions(parsed.data.tools, manifest);
    } else if (manifest.kind === "skillpack") {
      const parsed = skillPackSchema.safeParse(parse(entry));
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

    if (isComponentInstallKind(manifest.kind)) {
      // Validate against the exact rules `listComponents` applies after the
      // swap, so a component can never install into an invalid library slot.
      const loaded = await loadComponentFromDir(
        manifest.kind,
        manifest.id,
        staging,
      );
      if (!loaded.ok) {
        throw new Error(
          `installed ${manifest.kind} is invalid: ${loaded.issues
            .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
            .join("; ")}`,
        );
      }
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await commitStagedDir({
    staging,
    target: target.dir,
    id: manifest.id,
  });

  return files;
}

const BUILTIN_SOURCE_NAMES = new Set(["hn", "arxiv", "github"]);

async function installSourceTarget(input: {
  target: WorkshopInstallTarget;
  manifest: WorkshopManifest;
  entryContent: string;
  repo: string;
  commit: string;
  trust: WorkshopTrust;
  overwrite: boolean;
}): Promise<string[]> {
  const { target, manifest } = input;
  const parsed = sourceAssetSchema.safeParse(parse(input.entryContent));
  if (!parsed.success) {
    throw new Error(
      `installed source is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const name = parsed.data.metadata.name;
  if (name !== manifest.id) {
    throw new Error(
      `source name "${name}" does not match manifest id "${manifest.id}"`,
    );
  }
  if (BUILTIN_SOURCE_NAMES.has(name)) {
    throw new Error(`source name is reserved by a builtin: ${name}`);
  }

  const manifestPath = target.dir;
  const metaPath = path.join(target.root, `${manifest.id}.meta.json`);
  if (existsSync(manifestPath) && !input.overwrite) {
    throw new Error(
      `install target already exists: sources/${manifest.id}.yaml; pass overwrite to replace it`,
    );
  }

  const previous = {
    manifest: existsSync(manifestPath)
      ? await readFile(manifestPath, "utf8")
      : null,
    meta: existsSync(metaPath) ? await readFile(metaPath, "utf8") : null,
  };
  const entrySha256 = sha256Hex(input.entryContent);
  const homepage = (parsed.data.metadata as { homepage?: unknown }).homepage;
  const meta = {
    kind: "source",
    id: name,
    name,
    version: parsed.data.metadata.version,
    entry: manifest.entry,
    license: manifest.license,
    repo: input.repo,
    commit: input.commit,
    manifestSha256: entrySha256,
    installedAt: new Date().toISOString(),
    trust: input.trust.level,
    trustDetail: input.trust,
    permissions: { network: true, filesystem: "readonly", code: false },
    files: { [manifest.entry]: entrySha256 },
    manifest: {
      id: name,
      name,
      version: parsed.data.metadata.version,
      kind: "source",
      description: manifest.description,
    },
    ...(typeof homepage === "string" ? { homepage } : {}),
    secretScan: "passed",
  };

  try {
    await writeFileAtomic(manifestPath, input.entryContent);
    await writeJsonAtomic(metaPath, meta);
  } catch (error) {
    await restoreFile(manifestPath, previous.manifest);
    await restoreFile(metaPath, previous.meta);
    throw error;
  }

  return [manifest.entry];
}

async function installPipelineTarget(input: {
  target: WorkshopInstallTarget;
  manifest: WorkshopManifest;
  entryContent: string;
  repo: string;
  commit: string;
  manifestSha256: string;
  trust: WorkshopTrust;
  overwrite: boolean;
}): Promise<string[]> {
  const { target, manifest } = input;
  const host = target.root;
  const hostPack = await loadPack(host);
  if (!hostPack.ok) {
    throw new Error(
      `pipeline host pack is invalid: ${hostPack.errors.join("; ")}`,
    );
  }

  const parsed = pipelineSpecSchema.safeParse(parse(input.entryContent));
  if (!parsed.success) {
    throw new Error(
      `installed pipeline is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  if (parsed.data.id !== manifest.id) {
    throw new Error(
      `pipeline id "${parsed.data.id}" does not match manifest id "${manifest.id}"`,
    );
  }

  const workflow = pipelineWorkflow(parsed.data);
  const workflowPath = target.dir;
  const relative = path.relative(host, workflowPath).split(path.sep).join("/");
  if (existsSync(workflowPath) && !input.overwrite) {
    throw new Error(
      `install target already exists: ${relative}; pass overwrite to replace it`,
    );
  }

  const teamPath = path.join(host, "team.yaml");
  const recordPath = path.join(
    path.dirname(workflowPath),
    `${manifest.id}.workshop.json`,
  );
  const previous = {
    workflow: existsSync(workflowPath)
      ? await readFile(workflowPath, "utf8")
      : null,
    team: await readFile(teamPath, "utf8"),
    record: existsSync(recordPath) ? await readFile(recordPath, "utf8") : null,
  };

  try {
    await writeFileAtomic(workflowPath, stringify(workflow));
    const team = (parse(previous.team) ?? {}) as Record<string, unknown>;
    const workflows = Array.isArray(team.workflows)
      ? ([...team.workflows] as unknown[])
      : [];
    if (!workflows.includes(relative)) {
      workflows.push(relative);
    }
    await writeFileAtomic(teamPath, stringify({ ...team, workflows }));
    await writeJsonAtomic(recordPath, {
      ...installRecord({
        manifest,
        repo: input.repo,
        commit: input.commit,
        manifestSha256: input.manifestSha256,
        files: { [relative]: sha256Hex(stringify(workflow)) },
        trust: input.trust,
      }),
      target: relative,
    });

    const loaded = await loadPack(host);
    if (!loaded.ok) {
      throw new Error(
        `pipeline could not be registered in the host pack: ${loaded.errors.join("; ")}`,
      );
    }
  } catch (error) {
    await restoreFile(workflowPath, previous.workflow);
    await restoreFile(teamPath, previous.team);
    await restoreFile(recordPath, previous.record);
    throw error;
  }

  return [relative];
}

async function restoreFile(
  file: string,
  previous: string | null,
): Promise<void> {
  if (previous === null) {
    await rm(file, { force: true }).catch(() => undefined);
    return;
  }
  await writeFileAtomic(file, previous).catch(() => undefined);
}

/**
 * Project a pipeline graph onto the host pack's workflow format (plan 88
 * §3.4: pipelines land in the host pack's `workflows/` and run there).
 *
 * Pack stages have no native `human` type, so human nodes become a gate stage
 * (`type: workflow` plus a required approval) and subflow nodes become
 * `type: workflow` stages. Agent nodes bind their component id, falling back
 * to the node id so a host pack's same-named agent is used.
 */
function pipelineWorkflow(spec: PipelineSpec): WorkflowDefinition {
  const order = orderPipelineNodes(spec);
  const outputsById = new Map(
    spec.graph.nodes.map((node) => [node.id, node.outputs] as const),
  );
  const upstream = new Map<string, string[]>();
  for (const edge of spec.graph.edges) {
    upstream.set(edge.to, [...(upstream.get(edge.to) ?? []), edge.from]);
  }
  const bindings = new Map(
    spec.bindings.map((binding) => [binding.node, binding.component] as const),
  );

  const stages = order.map((node) => {
    const parents = upstream.get(node.id) ?? [];
    const inputs = node.inputs.length
      ? node.inputs
      : parents.flatMap((parent) => outputsById.get(parent) ?? []);
    const outputs = node.outputs.length ? node.outputs : ["result"];
    const stage: Record<string, unknown> = {
      id: node.id,
      inputs: inputs.length ? inputs : ["task"],
      outputs,
    };

    if (node.type === "agent") {
      stage.type = "agent";
      const ref = bindings.get(node.id) ?? node.component;
      stage.agent = ref?.kind === "agent" ? ref.id : node.id;
    } else if (node.type === "coder") {
      stage.type = "coder";
      stage.coder = "dsh";
    } else if (node.type === "human") {
      stage.type = "workflow";
      stage.approval = node.approval ?? {
        mode: "required",
        position: "before",
        riskClass: "medium",
        ttl: "7d",
      };
    } else {
      stage.type = "workflow";
    }

    if (node.gate) {
      stage.gate = node.gate;
    }
    if (node.type !== "human" && node.approval) {
      stage.approval = node.approval;
    }
    if (node.position) {
      stage.position = node.position;
    }
    if (parents.length === 1) {
      stage.inputFrom = parents[0];
    } else if (parents.length > 1) {
      stage.inputsFrom = parents;
    }
    return stage;
  });

  return workflowDefinitionSchema.parse({
    id: spec.id,
    version: spec.version,
    trigger: { event: "task.received" },
    stages,
    ...(spec.delivery ? { delivery: spec.delivery } : {}),
  });
}

/** Stable topological order; pipelines are acyclic by contract. */
function orderPipelineNodes(spec: PipelineSpec): PipelineNode[] {
  const nodes = spec.graph.nodes;
  const indegree = new Map(nodes.map((node) => [node.id, 0] as const));
  const children = new Map<string, string[]>();
  for (const edge of spec.graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  }
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  const ordered: PipelineNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as PipelineNode;
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) {
        const next = byId.get(child);
        if (next) {
          queue.push(next);
        }
      }
    }
  }
  if (ordered.length !== nodes.length) {
    throw new Error("pipeline graph contains a cycle");
  }
  return ordered;
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
