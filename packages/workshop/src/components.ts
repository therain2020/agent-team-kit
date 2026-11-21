import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ASSEMBLY_LOCK_FILE,
  type AgentFrontmatter,
  type AssemblyLock,
  COMPONENT_ENTRY,
  COMPONENT_ENV_ROOT,
  type ComponentKind,
  type ComponentRef,
  type ComponentSource,
  type PipelineSpec,
  type SkillPack,
  type SourceAsset,
  type TemplateDefinition,
  type ToolPack,
  type WorkflowDefinition,
  agentFrontmatterSchema,
  assemblyLockSchema,
  boundComponentKeys,
  componentKey,
  componentRefSchema,
  pipelineSpecSchema,
  skillPackSchema,
  sourceAssetSchema,
  templateDefinitionSchema,
  toolPackSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import type { ComponentLibrary, ResolvedComponent } from "@kit/pack";
import { splitFrontmatter } from "@kit/pack";
import { parse } from "yaml";
import { scanWorkshopSecrets } from "./security";

/**
 * Component library + assembly lockfile read model (plan 88 §3.1, M3a).
 *
 * Components live at `components/<kind>/<id>/` and are *not* runnable until a
 * pack's `components.lock.json` locks them and binds them to a node (M3b owns
 * the binding writes). This module only reads, validates and pins: it never
 * writes a host pack or installs a workshop item, so it does not overlap the
 * M0 install path.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const DESCRIPTOR_FILE = ".workshop.json";
const TEXT_FILE = /\.(?:md|ya?ml|json|txt)$/i;

export type LibraryIssueCode =
  | "component_not_found"
  | "component_id_invalid"
  | "descriptor_invalid"
  | "descriptor_mismatch"
  | "entry_missing"
  | "entry_escapes"
  | "entry_too_large"
  | "entry_parse_error"
  | "entry_invalid"
  | "entry_convention"
  | "file_missing"
  | "file_escapes"
  | "file_too_large"
  | "id_mismatch"
  | "version_mismatch"
  | "secret_detected"
  | "unsafe_path"
  | "lock_invalid"
  | "lock_component_missing"
  | "lock_component_invalid"
  | "lock_version_mismatch"
  | "lock_hash_mismatch"
  | "lock_missing_component";

export interface LibraryIssue {
  code: LibraryIssueCode;
  /** File-relative path, or `.` for the component root. */
  path: string;
  message: string;
}

export type ComponentSpec =
  | { kind: "agent"; data: AgentFrontmatter }
  | { kind: "workflow"; data: WorkflowDefinition }
  | { kind: "toolpack"; data: ToolPack }
  | { kind: "skillpack"; data: SkillPack };

export interface ComponentProvenance {
  repo: string;
  commit: string;
  ref?: string;
  manifestSha256?: string;
}

export interface ComponentSummary {
  kind: ComponentKind;
  id: string;
  dir: string;
  entry: string;
  version: string | null;
  sha256: string | null;
  valid: boolean;
  /** True only when a supplied lockfile binds this component to a node. */
  bound: boolean;
  provenance: ComponentProvenance | null;
  issues: LibraryIssue[];
}

export interface LoadedComponent extends ComponentSummary {
  spec: ComponentSpec;
}

export type LoadComponentResult =
  | { ok: true; component: LoadedComponent }
  | {
      ok: false;
      kind: ComponentKind;
      id: string;
      dir: string;
      issues: LibraryIssue[];
    };

interface Descriptor {
  kind: ComponentKind | null;
  id: string | null;
  version: string | null;
  entry: string;
  provenance: ComponentProvenance | null;
}

export function componentsRoot(root?: string): string {
  return path.resolve(
    root ??
      process.env[COMPONENT_ENV_ROOT] ??
      path.join(process.cwd(), "components"),
  );
}

/** Deterministic SHA-256 over a component's content (dotfiles excluded). */
export async function componentContentHash(dir: string): Promise<string> {
  const files = await collectFiles(dir);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function listComponents(
  root?: string,
  options: { lock?: AssemblyLock } = {},
): Promise<ComponentSummary[]> {
  const base = componentsRoot(root);
  if (!existsSync(base)) {
    return [];
  }
  const bound = options.lock ? new Set(boundComponentKeys(options.lock)) : null;

  const summaries: ComponentSummary[] = [];
  const kindDirs = await readdir(base, { withFileTypes: true });
  for (const kindDir of kindDirs) {
    if (!kindDir.isDirectory()) {
      continue;
    }
    const kind = kindDir.name;
    if (!isComponentKind(kind)) {
      continue;
    }
    const kindRoot = path.join(base, kind);
    const entries = await readdir(kindRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const result = await loadComponent(kind, entry.name, base);
      if (!result.ok) {
        summaries.push({
          kind,
          id: entry.name,
          dir: result.dir,
          entry: COMPONENT_ENTRY[kind],
          version: null,
          sha256: null,
          valid: false,
          bound: bound?.has(`${kind}/${entry.name}`) ?? false,
          provenance: null,
          issues: result.issues,
        });
        continue;
      }
      summaries.push({
        ...result.component,
        bound: bound?.has(componentKey(result.component)) ?? false,
      });
    }
  }

  return summaries.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

export async function loadComponent(
  kind: ComponentKind,
  id: string,
  root?: string,
): Promise<LoadComponentResult> {
  const base = componentsRoot(root);
  const dir = resolveComponentDir(base, kind, id);
  if (!dir) {
    return {
      ok: false,
      kind,
      id,
      dir: path.join(base, kind, id),
      issues: [
        {
          code: "component_id_invalid",
          path: ".",
          message: `invalid component id: ${id}`,
        },
      ],
    };
  }
  if (!existsSync(dir)) {
    return {
      ok: false,
      kind,
      id,
      dir,
      issues: [
        {
          code: "component_not_found",
          path: ".",
          message: `component not found: ${kind}/${id}`,
        },
      ],
    };
  }
  return loadComponentFromDir(kind, id, dir);
}

/**
 * Validate a component that already sits in its final layout
 * (`<kind dir>/<id>/`). Installs validate a staging directory with the same
 * rules the library applies after a swap, so a component can never install
 * into a state `listComponents` would reject.
 */
export async function loadComponentFromDir(
  kind: ComponentKind,
  id: string,
  dir: string,
): Promise<LoadComponentResult> {
  if (!existsSync(dir)) {
    return {
      ok: false,
      kind,
      id,
      dir,
      issues: [
        {
          code: "component_not_found",
          path: ".",
          message: `component not found: ${kind}/${id}`,
        },
      ],
    };
  }

  const issues: LibraryIssue[] = [];
  const descriptor = await readDescriptor(dir, kind, id, issues);

  const entry = descriptor.entry;
  const entryPath = safeJoin(dir, entry);
  if (!entryPath) {
    issues.push({
      code: "entry_escapes",
      path: entry,
      message: `entry escapes the component directory: ${entry}`,
    });
    return { ok: false, kind, id, dir, issues };
  }
  if (!existsSync(entryPath)) {
    issues.push({
      code: "entry_missing",
      path: entry,
      message: `component entry is missing: ${entry}`,
    });
    return { ok: false, kind, id, dir, issues };
  }

  const text = await readFile(entryPath, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    issues.push({
      code: "entry_too_large",
      path: entry,
      message: `entry exceeds ${MAX_FILE_BYTES} bytes`,
    });
    return { ok: false, kind, id, dir, issues };
  }

  const texts: Array<{ file: string; content: string }> = [
    { file: entry, content: text },
  ];

  const spec = await parseComponentSpec(
    kind,
    id,
    dir,
    entry,
    text,
    texts,
    issues,
  );
  if (!spec) {
    return { ok: false, kind, id, dir, issues };
  }

  appendSecretIssues(texts, issues);

  const version = deriveVersion(spec, descriptor, issues);
  const sha256 = issues.length === 0 ? await componentContentHash(dir) : null;

  if (issues.length > 0) {
    return { ok: false, kind, id, dir, issues };
  }

  return {
    ok: true,
    component: {
      kind,
      id,
      dir,
      entry,
      version,
      sha256,
      valid: true,
      bound: false,
      provenance: descriptor.provenance,
      issues: [],
      spec,
    },
  };
}

/**
 * Turn a validated component into a pinned `ComponentRef`. Installed
 * components keep their repo/commit provenance; locally authored ones get a
 * deterministic `local/<id>` source whose commit is derived from the content
 * hash so the ref is still reproducible.
 */
export async function buildComponentRef(
  kind: ComponentKind,
  id: string,
  root?: string,
  options: { fallbackVersion?: string } = {},
): Promise<ComponentRef> {
  const result = await loadComponent(kind, id, root);
  if (!result.ok) {
    throw new Error(
      `cannot lock invalid component ${kind}/${id}: ${result.issues
        .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const component = result.component;
  const version = component.version ?? options.fallbackVersion ?? "0.0.0";
  const sha256 =
    component.sha256 ?? (await componentContentHash(component.dir));
  const source: ComponentSource = component.provenance
    ? {
        repo: component.provenance.repo,
        commit: component.provenance.commit,
        ...(component.provenance.ref ? { ref: component.provenance.ref } : {}),
        sha256,
      }
    : {
        repo: `local/${id}`,
        commit: sha256.slice(0, 40),
        ref: "local",
        sha256,
      };

  return componentRefSchema.parse({ kind, id, version, source });
}

export function assemblyLockPath(packDir: string): string {
  return path.join(path.resolve(packDir), ASSEMBLY_LOCK_FILE);
}

export interface AssemblyLockReadResult {
  ok: boolean;
  exists: boolean;
  lock: AssemblyLock;
  issues: LibraryIssue[];
}

export async function readAssemblyLock(
  packDir: string,
): Promise<AssemblyLockReadResult> {
  const file = assemblyLockPath(packDir);
  if (!existsSync(file)) {
    return { ok: true, exists: false, lock: emptyLock(), issues: [] };
  }
  let data: unknown;
  try {
    data = parse(await readFile(file, "utf8"));
  } catch (error) {
    return {
      ok: false,
      exists: true,
      lock: emptyLock(),
      issues: [
        {
          code: "lock_invalid",
          path: ASSEMBLY_LOCK_FILE,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const parsed = assemblyLockSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      exists: true,
      lock: emptyLock(),
      issues: parsed.error.issues.map((issue) => ({
        code: "lock_invalid" as const,
        path: issue.path.join(".") || ASSEMBLY_LOCK_FILE,
        message: issue.message,
      })),
    };
  }
  return { ok: true, exists: true, lock: parsed.data, issues: [] };
}

export interface AssemblyLockWriteResult {
  ok: boolean;
  path: string;
  issues: LibraryIssue[];
}

export async function writeAssemblyLock(
  packDir: string,
  lock: AssemblyLock,
): Promise<AssemblyLockWriteResult> {
  const parsed = assemblyLockSchema.safeParse(lock);
  if (!parsed.success) {
    return {
      ok: false,
      path: assemblyLockPath(packDir),
      issues: parsed.error.issues.map((issue) => ({
        code: "lock_invalid" as const,
        path: issue.path.join(".") || ASSEMBLY_LOCK_FILE,
        message: issue.message,
      })),
    };
  }
  const file = assemblyLockPath(packDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(parsed.data, null, 2)}\n`,
    "utf8",
  );
  await rename(temporary, file);
  return { ok: true, path: file, issues: [] };
}

/** Insert or replace one locked component reference, preserving the rest. */
export async function upsertLockedComponent(
  packDir: string,
  ref: ComponentRef,
): Promise<AssemblyLockWriteResult> {
  const current = await readAssemblyLock(packDir);
  if (!current.ok) {
    return {
      ok: false,
      path: assemblyLockPath(packDir),
      issues: current.issues,
    };
  }
  const key = componentKey(ref);
  const components = current.lock.components.filter(
    (entry) => componentKey(entry) !== key,
  );
  components.push(ref);
  components.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
  return writeAssemblyLock(packDir, {
    ...current.lock,
    components,
    generatedAt: new Date().toISOString(),
  });
}

export type LockVerificationStatus =
  | "ok"
  | "missing"
  | "invalid"
  | "version-mismatch"
  | "hash-mismatch";

export interface LockVerificationEntry {
  ref: ComponentRef;
  status: LockVerificationStatus;
  actualVersion: string | null;
  actualSha256: string | null;
  bound: boolean;
  issues: LibraryIssue[];
}

export interface LockVerification {
  ok: boolean;
  entries: LockVerificationEntry[];
  issues: LibraryIssue[];
}

/**
 * Check a lockfile against the component library: every locked ref must exist,
 * still match its pinned version and content hash. Bound-but-unlocked and
 * locked-but-unbound states are reported through `bound` and schema checks.
 */
export async function verifyAssemblyLock(
  lock: AssemblyLock,
  root?: string,
): Promise<LockVerification> {
  const bound = new Set(boundComponentKeys(lock));
  const entries: LockVerificationEntry[] = [];
  const issues: LibraryIssue[] = [];

  for (const ref of lock.components) {
    const isBound = bound.has(componentKey(ref));
    const result = await loadComponent(ref.kind, ref.id, root);
    if (!result.ok) {
      const missing = result.issues.some(
        (issue) => issue.code === "component_not_found",
      );
      const entry: LockVerificationEntry = {
        ref,
        status: missing ? "missing" : "invalid",
        actualVersion: null,
        actualSha256: null,
        bound: isBound,
        issues: result.issues,
      };
      entries.push(entry);
      issues.push(
        ...result.issues.map((issue) => ({
          code: (missing
            ? "lock_component_missing"
            : "lock_component_invalid") as LibraryIssueCode,
          path: `${componentKey(ref)}/${issue.path}`,
          message: issue.message,
        })),
      );
      continue;
    }

    const component = result.component;
    const actualSha256 =
      component.sha256 ?? (await componentContentHash(component.dir));
    const versionMismatch =
      component.version !== null && component.version !== ref.version;
    const hashMismatch = actualSha256 !== ref.source.sha256;
    const status: LockVerificationStatus = versionMismatch
      ? "version-mismatch"
      : hashMismatch
        ? "hash-mismatch"
        : "ok";

    const entryIssues: LibraryIssue[] = [];
    if (versionMismatch) {
      const issue: LibraryIssue = {
        code: "lock_version_mismatch",
        path: componentKey(ref),
        message: `locked ${ref.version}, library has ${component.version}`,
      };
      entryIssues.push(issue);
      issues.push(issue);
    }
    if (hashMismatch) {
      const issue: LibraryIssue = {
        code: "lock_hash_mismatch",
        path: componentKey(ref),
        message: `locked sha256 ${ref.source.sha256}, library has ${actualSha256}`,
      };
      entryIssues.push(issue);
      issues.push(issue);
    }

    entries.push({
      ref,
      status,
      actualVersion: component.version,
      actualSha256,
      bound: isBound,
      issues: entryIssues,
    });
  }

  return { ok: issues.length === 0, entries, issues };
}

/** True when the ref is bound to a node in the lockfile (thus runnable). */
export function isComponentBound(
  lock: AssemblyLock,
  ref: Pick<ComponentRef, "kind" | "id">,
): boolean {
  return boundComponentKeys(lock).includes(componentKey(ref));
}

/**
 * Production {@link ComponentLibrary} adapter for the pack assembler (plan 88
 * §3.1 / M3b). Resolves a component to a pinned, validated snapshot (entry text
 * plus supporting files) and reads/writes the pack's `components.lock.json`.
 * Kept in `@kit/workshop` because it owns the component read model; the
 * assembler in `@kit/pack` consumes it through the port so the two packages do
 * not form a dependency cycle.
 */
export function workshopComponentLibrary(root?: string): ComponentLibrary {
  return {
    async resolve(kind, id) {
      const result = await loadComponent(kind, id, root);
      if (!result.ok) {
        return { ok: false, issues: result.issues };
      }
      const component = result.component;
      const ref = await buildComponentRef(kind, id, root, {
        fallbackVersion: component.version ?? undefined,
      });
      const entryText = await readFile(
        path.join(component.dir, component.entry),
        "utf8",
      );
      const files: Array<{ path: string; content: string }> = [];
      if (component.spec.kind === "skillpack") {
        for (const file of component.spec.data.files) {
          files.push({
            path: file,
            content: await readFile(path.join(component.dir, file), "utf8"),
          });
        }
      }
      const resolved: ResolvedComponent = {
        kind,
        id,
        version: ref.version,
        ref,
        spec: component.spec,
        entryText,
        files,
      };
      return { ok: true, component: resolved };
    },
    async readLock(packDir) {
      const read = await readAssemblyLock(packDir);
      return { ok: read.ok, lock: read.lock, issues: read.issues };
    },
    async writeLock(packDir, lock) {
      const write = await writeAssemblyLock(packDir, lock);
      return { ok: write.ok, issues: write.issues };
    },
  };
}

export type AssetKind = "pipeline" | "source" | "template";

export interface AssetValidationResult {
  ok: boolean;
  kind: AssetKind;
  entry: string;
  issues: LibraryIssue[];
}

const ASSET_ENTRY_FILES: Record<AssetKind, string> = {
  pipeline: "pipeline.yaml",
  source: "source.yaml",
  template: "template.yaml",
};

/**
 * Validate the entry file of a pipeline/source/template asset directory. These
 * kinds reuse the workshop manifest contract but have fixed entry filenames
 * (plan 88 §2/§3.1) so discovery, install and publish cannot disagree.
 */
export async function validateAssetEntry(input: {
  kind: AssetKind;
  dir: string;
  entry?: string;
}): Promise<AssetValidationResult> {
  const dir = path.resolve(input.dir);
  const expected = ASSET_ENTRY_FILES[input.kind];
  const issues: LibraryIssue[] = [];

  if (input.entry && input.entry !== expected) {
    issues.push({
      code: "entry_convention",
      path: "entry",
      message: `${input.kind} assets must use entry ${expected}`,
    });
  }

  const file = safeJoin(dir, expected);
  if (!file) {
    issues.push({
      code: "entry_escapes",
      path: expected,
      message: `entry escapes the asset directory: ${expected}`,
    });
    return { ok: false, kind: input.kind, entry: expected, issues };
  }
  if (!existsSync(file)) {
    issues.push({
      code: "entry_missing",
      path: expected,
      message: `asset entry is missing: ${expected}`,
    });
    return { ok: false, kind: input.kind, entry: expected, issues };
  }

  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    issues.push({
      code: "entry_too_large",
      path: expected,
      message: `entry exceeds ${MAX_FILE_BYTES} bytes`,
    });
    return { ok: false, kind: input.kind, entry: expected, issues };
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    issues.push({
      code: "entry_parse_error",
      path: expected,
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, kind: input.kind, entry: expected, issues };
  }

  const schema =
    input.kind === "pipeline"
      ? pipelineSpecSchema
      : input.kind === "template"
        ? templateDefinitionSchema
        : sourceAssetSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((issue) => ({
        code: "entry_invalid" as const,
        path: `${expected}:${issue.path.join(".") || "<root>"}`,
        message: issue.message,
      })),
    );
  }

  appendSecretIssues([{ file: expected, content: text }], issues);
  return { ok: issues.length === 0, kind: input.kind, entry: expected, issues };
}

async function parseComponentSpec(
  kind: ComponentKind,
  id: string,
  dir: string,
  entry: string,
  text: string,
  texts: Array<{ file: string; content: string }>,
  issues: LibraryIssue[],
): Promise<ComponentSpec | null> {
  if (kind === "agent") {
    const { data } = splitFrontmatter(text);
    const parsed = agentFrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      pushInvalidIssues(entry, parsed.error.issues, issues);
      return null;
    }
    if (parsed.data.name !== id) {
      issues.push({
        code: "id_mismatch",
        path: entry,
        message: `agent name "${parsed.data.name}" does not match component id "${id}"`,
      });
    }
    return { kind, data: parsed.data };
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    issues.push({
      code: "entry_parse_error",
      path: entry,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (kind === "workflow") {
    const parsed = workflowDefinitionSchema.safeParse(data);
    if (!parsed.success) {
      pushInvalidIssues(entry, parsed.error.issues, issues);
      return null;
    }
    return { kind, data: parsed.data };
  }

  if (kind === "toolpack") {
    const parsed = toolPackSchema.safeParse(data);
    if (!parsed.success) {
      pushInvalidIssues(entry, parsed.error.issues, issues);
      return null;
    }
    return { kind, data: parsed.data };
  }

  const parsed = skillPackSchema.safeParse(data);
  if (!parsed.success) {
    pushInvalidIssues(entry, parsed.error.issues, issues);
    return null;
  }

  const skillPack = parsed.data;
  let total = Buffer.byteLength(text, "utf8");
  for (const file of skillPack.files) {
    const absolute = safeJoin(dir, file);
    if (!absolute) {
      issues.push({
        code: "file_escapes",
        path: file,
        message: `skillpack file escapes the component directory: ${file}`,
      });
      continue;
    }
    if (!existsSync(absolute)) {
      issues.push({
        code: "file_missing",
        path: file,
        message: `skillpack file is missing: ${file}`,
      });
      continue;
    }
    const content = await readFile(absolute, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      issues.push({
        code: "file_too_large",
        path: file,
        message: `skillpack file exceeds ${MAX_FILE_BYTES} bytes`,
      });
      continue;
    }
    total += bytes;
    if (TEXT_FILE.test(file)) {
      texts.push({ file, content });
    }
    if (file === skillPack.entry) {
      const { data: frontmatter } = splitFrontmatter(content);
      if (
        typeof frontmatter.name === "string" &&
        frontmatter.name !== skillPack.name
      ) {
        issues.push({
          code: "id_mismatch",
          path: file,
          message: `skill name "${frontmatter.name}" does not match skillpack name "${skillPack.name}"`,
        });
      }
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    issues.push({
      code: "file_too_large",
      path: ".",
      message: `skillpack exceeds ${MAX_TOTAL_BYTES} bytes`,
    });
  }
  return { kind, data: skillPack };
}

async function readDescriptor(
  dir: string,
  kind: ComponentKind,
  id: string,
  issues: LibraryIssue[],
): Promise<Descriptor> {
  const fallback: Descriptor = {
    kind,
    id,
    version: null,
    entry: COMPONENT_ENTRY[kind],
    provenance: null,
  };
  const file = path.join(dir, DESCRIPTOR_FILE);
  if (!existsSync(file)) {
    return fallback;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    issues.push({
      code: "descriptor_invalid",
      path: DESCRIPTOR_FILE,
      message: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }

  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string" || !isComponentKind(raw.kind)) {
      issues.push({
        code: "descriptor_invalid",
        path: `${DESCRIPTOR_FILE}:kind`,
        message: `unknown component kind: ${String(raw.kind)}`,
      });
    } else if (raw.kind !== kind) {
      issues.push({
        code: "descriptor_mismatch",
        path: `${DESCRIPTOR_FILE}:kind`,
        message: `descriptor kind ${raw.kind} does not match path kind ${kind}`,
      });
    }
  }
  if (raw.id !== undefined && raw.id !== id) {
    issues.push({
      code: "descriptor_mismatch",
      path: `${DESCRIPTOR_FILE}:id`,
      message: `descriptor id ${String(raw.id)} does not match path id ${id}`,
    });
  }

  const entry =
    typeof raw.entry === "string" && raw.entry.length > 0
      ? raw.entry
      : fallback.entry;

  let provenance: ComponentProvenance | null = null;
  if (typeof raw.repo === "string" && typeof raw.commit === "string") {
    provenance = {
      repo: raw.repo,
      commit: raw.commit,
      ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}),
      ...(typeof raw.manifestSha256 === "string"
        ? { manifestSha256: raw.manifestSha256 }
        : {}),
    };
  }

  return {
    kind,
    id,
    version: typeof raw.version === "string" ? raw.version : null,
    entry,
    provenance,
  };
}

function deriveVersion(
  spec: ComponentSpec,
  descriptor: Descriptor,
  issues: LibraryIssue[],
): string | null {
  const specVersion =
    spec.kind === "agent" ? null : (spec.data.version ?? null);
  if (
    descriptor.version !== null &&
    specVersion !== null &&
    descriptor.version !== specVersion
  ) {
    issues.push({
      code: "version_mismatch",
      path: DESCRIPTOR_FILE,
      message: `descriptor version ${descriptor.version} does not match entry version ${specVersion}`,
    });
  }
  return specVersion ?? descriptor.version;
}

function pushInvalidIssues(
  entry: string,
  zodIssues: Array<{ path: Array<string | number>; message: string }>,
  issues: LibraryIssue[],
): void {
  for (const issue of zodIssues) {
    issues.push({
      code: "entry_invalid",
      path: `${entry}:${issue.path.join(".") || "<root>"}`,
      message: issue.message,
    });
  }
}

function appendSecretIssues(
  texts: Array<{ file: string; content: string }>,
  issues: LibraryIssue[],
): void {
  for (const finding of scanWorkshopSecrets(texts)) {
    issues.push({
      code: "secret_detected",
      path: `${finding.file}:${finding.line}`,
      message: `secret-like content (${finding.label})`,
    });
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }

  await walk(dir, "");
  return files.sort();
}

function resolveComponentDir(
  base: string,
  kind: ComponentKind,
  id: string,
): string | null {
  if (!ID_PATTERN.test(id)) {
    return null;
  }
  const target = path.resolve(base, kind, id);
  if (!target.startsWith(`${path.resolve(base)}${path.sep}`)) {
    return null;
  }
  return target;
}

function safeJoin(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function isComponentKind(value: string): value is ComponentKind {
  return COMPONENT_ENTRY[value as ComponentKind] !== undefined;
}

function emptyLock(): AssemblyLock {
  return assemblyLockSchema.parse({});
}

export type {
  AgentFrontmatter,
  AssemblyLock,
  ComponentKind,
  ComponentRef,
  PipelineSpec,
  SkillPack,
  SourceAsset,
  TemplateDefinition,
  ToolPack,
  WorkflowDefinition,
};
