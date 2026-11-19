import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  ASSET_ENTRY,
  ASSET_KINDS,
  COMPONENT_ENTRY,
  COMPONENT_KINDS,
  type ComponentKind,
  type WorkshopManifest,
  agentFrontmatterSchema,
  pipelineSpecSchema,
  skillPackSchema,
  sourceAssetSchema,
  teamPackSchema,
  templateDefinitionSchema,
  toolPackSchema,
  workflowDefinitionSchema,
  workshopManifestSchema,
} from "@kit/core";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  resolveInside,
  sha256Hex,
  writeFileAtomic,
} from "@kit/market";
import { loadPack, splitFrontmatter } from "@kit/pack";
import { parse, stringify } from "yaml";
import { type WorkshopFileContent, scanWorkshopSecrets } from "./security";
import {
  type WorkshopTrustedKey,
  loadWorkshopTrustedKeys,
  verifyWorkshopSignature,
} from "./trust";

/**
 * Unified publish pipeline (plan 88 §3.4/§6.1 M3c, D-69).
 *
 * Publishing is split into one publisher per asset family — pack, pipeline,
 * component (agent/workflow/toolpack/skillpack) and template. Each publisher
 * derives `workshop.yaml` from the asset's entry file; a shared audit stage
 * then runs the same checklist for every kind: entry, files, size, secret,
 * code permission, README, license, topic and signature. Publishing never
 * pushes: it only writes the manifest locally when every check passes.
 */

export const WORKSHOP_TOPIC = "agent-team-workshop";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
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

const PIPELINE_ENTRY = ASSET_ENTRY.pipeline ?? "pipeline.yaml";
const TEMPLATE_ENTRY = ASSET_ENTRY.template ?? "template.yaml";
const DEFAULT_VERSION = "0.1.0";

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

/** Publisher family that produced or validated the manifest. */
export type WorkshopPublisherKind =
  | "pack"
  | "pipeline"
  | "component"
  | "template";

export interface WorkshopPublishResult {
  dir: string;
  manifestPath: string;
  /** Existing manifest, or one generated from the entry file. */
  manifest: WorkshopManifest | null;
  kind: WorkshopManifest["kind"] | null;
  /**
   * Publisher family that ran. `null` means publishing failed before a
   * publisher could be selected, or the kind has no publisher yet (source).
   */
  publisher: WorkshopPublisherKind | null;
  generated: boolean;
  written: boolean;
  files: WorkshopPublishFile[];
  permissions: WorkshopManifest["permissions"] | null;
  risk: WorkshopRisk;
  checks: WorkshopPublishCheck[];
  ok: boolean;
}

interface PublishContext {
  kind: WorkshopManifest["kind"];
  /** Local files collected from the asset directory (dotfiles excluded). */
  files: string[];
  /** True when the audit detected executable code in the asset. */
  code: boolean;
  /** Record an advisory check (never fatal) while generating. */
  warn(id: string, detail: string): void;
  /** Read a declared entry file; throws a readable PublishFailure if absent. */
  read(entry: string): Promise<string>;
}

interface WorkshopPublisher {
  id: WorkshopPublisherKind;
  kinds: readonly WorkshopManifest["kind"][];
  /** Entry file the publisher reads to generate a manifest. */
  entry(kind: WorkshopManifest["kind"]): string;
  build(context: PublishContext): Promise<Record<string, unknown>>;
}

/** A readable, asset-level publish error. Never leaks a raw exception. */
class PublishFailure extends Error {}

const PACK_PUBLISHER: WorkshopPublisher = {
  id: "pack",
  kinds: ["pack"],
  entry: () => "team.yaml",
  async build(context) {
    const team = teamPackSchema.safeParse(await readYaml(context, "team.yaml"));
    if (!team.success) {
      throw new PublishFailure(
        `team.yaml is invalid: ${formatIssues(team.error)}`,
      );
    }
    const metadata = team.data.metadata;
    const id = requireId(
      metadata.name.toLowerCase(),
      `pack name "${metadata.name}"`,
    );
    return {
      apiVersion: "agentteam/v1",
      kind: "pack",
      id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description ?? "",
      entry: "team.yaml",
      files: context.files,
      topics: [WORKSHOP_TOPIC],
      permissions: {
        network: false,
        filesystem: "workspace",
        code: context.code,
      },
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.compatibility
        ? { compatibility: metadata.compatibility }
        : {}),
    };
  },
};

const PIPELINE_PUBLISHER: WorkshopPublisher = {
  id: "pipeline",
  kinds: ["pipeline"],
  entry: () => PIPELINE_ENTRY,
  async build(context) {
    const spec = pipelineSpecSchema.safeParse(
      await readYaml(context, PIPELINE_ENTRY),
    );
    if (!spec.success) {
      throw new PublishFailure(
        `${PIPELINE_ENTRY} is invalid: ${formatIssues(spec.error)}`,
      );
    }
    return {
      apiVersion: "agentteam/v1",
      kind: "pipeline",
      id: requireId(spec.data.id, "pipeline id"),
      name: spec.data.name ?? spec.data.id,
      version: requireVersion(spec.data.version, "pipeline"),
      description: spec.data.description,
      entry: PIPELINE_ENTRY,
      files: context.files,
      topics: [WORKSHOP_TOPIC],
      permissions: declarativePermissions(context),
    };
  },
};

const TEMPLATE_PUBLISHER: WorkshopPublisher = {
  id: "template",
  kinds: ["template"],
  entry: () => TEMPLATE_ENTRY,
  async build(context) {
    const template = templateDefinitionSchema.safeParse(
      await readYaml(context, TEMPLATE_ENTRY),
    );
    if (!template.success) {
      throw new PublishFailure(
        `${TEMPLATE_ENTRY} is invalid: ${formatIssues(template.error)}`,
      );
    }
    context.warn(
      "version",
      `template.yaml has no version field; defaulted to ${DEFAULT_VERSION}. Set a release version in workshop.yaml before publishing a new version.`,
    );
    return {
      apiVersion: "agentteam/v1",
      kind: "template",
      id: requireId(template.data.id, "template id"),
      name: template.data.name,
      version: DEFAULT_VERSION,
      description: template.data.description,
      entry: TEMPLATE_ENTRY,
      files: context.files,
      topics: [WORKSHOP_TOPIC],
      permissions: declarativePermissions(context),
    };
  },
};

const COMPONENT_PUBLISHER: WorkshopPublisher = {
  id: "component",
  kinds: COMPONENT_KINDS,
  entry: (kind) => componentEntry(kind),
  async build(context) {
    const kind = asComponentKind(context.kind);
    const entry = componentEntry(kind);

    if (kind === "agent") {
      const { data } = splitFrontmatter(await context.read(entry));
      const agent = agentFrontmatterSchema.safeParse(data);
      if (!agent.success) {
        throw new PublishFailure(
          `${entry} is invalid: ${formatIssues(agent.error)}`,
        );
      }
      context.warn(
        "version",
        `agent frontmatter has no version; defaulted to ${DEFAULT_VERSION}. Set a release version in workshop.yaml before publishing a new version.`,
      );
      return {
        apiVersion: "agentteam/v1",
        kind,
        id: requireId(agent.data.name, "agent name"),
        name: agent.data.name,
        version: DEFAULT_VERSION,
        description: agent.data.description,
        entry,
        files: context.files,
        topics: [WORKSHOP_TOPIC],
        permissions: agentPermissions(context, agent.data.permissions),
      };
    }

    const data = await readYaml(context, entry);
    if (kind === "workflow") {
      const parsed = workflowDefinitionSchema.safeParse(data);
      if (!parsed.success) {
        throw new PublishFailure(
          `${entry} is invalid: ${formatIssues(parsed.error)}`,
        );
      }
      return {
        apiVersion: "agentteam/v1",
        kind,
        id: requireId(parsed.data.id, "workflow id"),
        name: parsed.data.id,
        version: requireVersion(parsed.data.version, kind),
        description: "",
        entry,
        files: context.files,
        topics: [WORKSHOP_TOPIC],
        permissions: declarativePermissions(context),
      };
    }

    const parsed =
      kind === "toolpack"
        ? toolPackSchema.safeParse(data)
        : skillPackSchema.safeParse(data);
    if (!parsed.success) {
      throw new PublishFailure(
        `${entry} is invalid: ${formatIssues(parsed.error)}`,
      );
    }
    return {
      apiVersion: "agentteam/v1",
      kind,
      id: requireId(parsed.data.name, `${kind} name`),
      name: parsed.data.name,
      version: requireVersion(parsed.data.version, kind),
      description: parsed.data.description,
      entry,
      files: context.files,
      topics: [WORKSHOP_TOPIC],
      permissions: declarativePermissions(context),
    };
  },
};

const PUBLISHERS: readonly WorkshopPublisher[] = [
  PACK_PUBLISHER,
  PIPELINE_PUBLISHER,
  COMPONENT_PUBLISHER,
  TEMPLATE_PUBLISHER,
];

export function publisherForKind(
  kind: WorkshopManifest["kind"],
): WorkshopPublisher | null {
  return PUBLISHERS.find((publisher) => publisher.kinds.includes(kind)) ?? null;
}

export async function publishWorkshop(
  input: {
    dir?: string;
    /** Disambiguate when the directory has no workshop.yaml. */
    kind?: WorkshopManifest["kind"];
    write?: boolean;
  } = {},
): Promise<WorkshopPublishResult> {
  const dir = path.resolve(input.dir ?? process.cwd());
  const manifestPath = path.join(dir, "workshop.yaml");
  const checks: WorkshopPublishCheck[] = [];
  let kind = input.kind ?? null;

  if (!existsSync(dir)) {
    checks.push(
      check("manifest", "fail", `workshop directory not found: ${dir}`),
    );
    return failedResult(dir, manifestPath, kind, null, checks);
  }

  const localFiles = await collectWorkshopFiles(dir);
  const detection = await detectCode(dir, localFiles);
  let manifest: WorkshopManifest | null = null;
  let publisher: WorkshopPublisher | null = null;
  let generated = false;
  let rawManifest: string | null = null;

  if (existsSync(manifestPath)) {
    rawManifest = await readFile(manifestPath, "utf8");
    let data: unknown;
    try {
      data = parse(rawManifest);
    } catch (error) {
      checks.push(
        check(
          "manifest",
          "fail",
          `workshop.yaml parse error: ${messageOf(error)}`,
        ),
      );
      return failedResult(dir, manifestPath, kind, null, checks);
    }
    const parsed = workshopManifestSchema.safeParse(data);
    if (!parsed.success) {
      checks.push(
        check(
          "manifest",
          "fail",
          `invalid workshop.yaml: ${formatIssues(parsed.error)}`,
        ),
      );
      return failedResult(
        dir,
        manifestPath,
        parsedKind(data) ?? kind,
        null,
        checks,
      );
    }
    manifest = parsed.data;
    kind = manifest.kind;
    publisher = publisherForKind(kind);
    checks.push(check("manifest", "pass", "workshop.yaml is valid"));
  } else {
    kind = kind ?? inferKind(localFiles);
    if (!kind) {
      checks.push(
        check(
          "manifest",
          "fail",
          "no workshop.yaml and no recognised entry: expected team.yaml, pipeline.yaml, template.yaml, agent.md, workflow.yaml, toolpack.yaml or skillpack.yaml",
        ),
      );
      return failedResult(dir, manifestPath, kind, null, checks);
    }
    publisher = publisherForKind(kind);
    if (!publisher) {
      checks.push(
        check(
          "manifest",
          "fail",
          `generating a ${kind} manifest is not supported yet; add workshop.yaml by hand (source publishing lands with the unified market kernel, M1 #115)`,
        ),
      );
      return failedResult(dir, manifestPath, kind, null, checks);
    }

    try {
      const draft = await publisher.build({
        kind,
        files: localFiles,
        code: detection.code,
        warn: (id, detail) => checks.push(check(id, "warn", detail)),
        read: (entry) => readEntry(dir, entry),
      });
      const parsed = workshopManifestSchema.safeParse(draft);
      if (!parsed.success) {
        throw new PublishFailure(
          `generated manifest is invalid: ${formatIssues(parsed.error)}`,
        );
      }
      manifest = parsed.data;
      generated = true;
      checks.push(
        check(
          "manifest",
          "pass",
          `workshop.yaml generated from ${publisher.entry(kind)}`,
        ),
      );
    } catch (error) {
      checks.push(check(publisher.id, "fail", messageOf(error)));
      return failedResult(dir, manifestPath, kind, publisher.id, checks);
    }
  }

  if (!manifest) {
    return failedResult(dir, manifestPath, kind, publisher?.id ?? null, checks);
  }

  // ---- shared audit: every kind runs the same checklist ----
  // Code detection follows the published file set, so an undeclared local
  // script does not fail the item (it is only a warning under `undeclared`).
  const publishedDetection = await detectCode(dir, manifest.files);
  const files: WorkshopPublishFile[] = [];
  const texts: WorkshopFileContent[] = [];
  const missing: string[] = [];
  const oversize: string[] = [];
  let total = 0;

  for (const file of manifest.files) {
    let absolute: string;
    try {
      absolute = resolveInside(dir, file);
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
    texts.push({ file, content: content.toString("utf8") });
    files.push({
      path: file,
      bytes: content.length,
      sha256: sha256Hex(content),
    });
  }

  if (!manifest.files.includes(manifest.entry)) {
    checks.push(check("entry", "fail", "entry must be listed in files"));
  } else if (missing.includes(manifest.entry)) {
    checks.push(
      check("entry", "fail", `entry file is missing: ${manifest.entry}`),
    );
  } else {
    checks.push(check("entry", "pass", `entry ${manifest.entry} is present`));
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

  const secretFindings = scanWorkshopSecrets([
    { file: "workshop.yaml", content: rawManifest ?? stringify(manifest) },
    ...texts,
  ]);
  if (secretFindings.length > 0) {
    checks.push(
      check(
        "secret",
        "fail",
        `secret-like content found: ${secretFindings
          .map(
            (finding) => `${finding.file}:${finding.line} (${finding.label})`,
          )
          .join("; ")}`,
      ),
    );
  } else {
    checks.push(
      check("secret", "pass", "no secret-like content in declared files"),
    );
  }

  if (publishedDetection.code && !manifest.permissions.code) {
    checks.push(
      check(
        "code",
        "fail",
        "executable code detected but permissions.code is false",
      ),
    );
  } else if (publishedDetection.code) {
    checks.push(
      check(
        "code",
        "warn",
        `executable code: ${publishedDetection.reasons.slice(0, 4).join("; ")} — installation requires explicit code consent`,
      ),
    );
  } else {
    checks.push(check("code", "pass", "no executable code detected"));
  }

  const hasReadme = manifest.files.some((file) =>
    /^readme(?:\.md)?$/i.test(path.basename(file)),
  );
  if (hasReadme) {
    checks.push(check("readme", "pass", "README present"));
  } else if (manifest.kind === "template") {
    checks.push(
      check("readme", "fail", "templates require a README.md at the root"),
    );
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

  checks.push(await signatureCheck(manifest));
  await validateEntry(dir, manifest, checks);

  const ok = checks.every((item) => item.status !== "fail");
  let written = false;
  if (generated && input.write !== false && ok) {
    await writeFileAtomic(manifestPath, stringify(manifest));
    written = true;
  }

  return {
    dir,
    manifestPath,
    manifest,
    kind: manifest.kind,
    publisher: publisher?.id ?? null,
    generated,
    written,
    files,
    permissions: manifest.permissions,
    risk: summarizeRisk(manifest),
    checks,
    ok,
  };
}

function failedResult(
  dir: string,
  manifestPath: string,
  kind: WorkshopManifest["kind"] | null,
  publisher: WorkshopPublisherKind | null,
  checks: WorkshopPublishCheck[],
): WorkshopPublishResult {
  return {
    dir,
    manifestPath,
    manifest: null,
    kind,
    publisher,
    generated: false,
    written: false,
    files: [],
    permissions: null,
    risk: {
      level: "low",
      reasons: ["publish checks did not produce a manifest"],
    },
    checks,
    ok: false,
  };
}

async function validateEntry(
  dir: string,
  manifest: WorkshopManifest,
  checks: WorkshopPublishCheck[],
): Promise<void> {
  let entryPath: string;
  try {
    entryPath = resolveInside(dir, manifest.entry);
  } catch {
    return; // the entry/files checks already report unsafe paths
  }
  if (!existsSync(entryPath)) {
    return; // the entry/files checks already report missing files
  }

  switch (manifest.kind) {
    case "pack": {
      const loaded = await loadPack(dir);
      checks.push(
        loaded.ok
          ? check("pack", "pass", "pack loads and validates")
          : check(
              "pack",
              "fail",
              `pack is invalid: ${loaded.errors.join("; ")}`,
            ),
      );
      return;
    }
    case "pipeline": {
      const raw = await parseFile(entryPath, checks, "pipeline");
      if (!raw) {
        return;
      }
      const parsed = pipelineSpecSchema.safeParse(raw.data);
      if (!parsed.success) {
        checks.push(
          check(
            "pipeline",
            "fail",
            `${manifest.entry} is invalid: ${formatIssues(parsed.error)}`,
          ),
        );
        return;
      }
      checks.push(check("pipeline", "pass", "pipeline spec validates"));
      if (parsed.data.id !== manifest.id) {
        checks.push(
          check(
            "pipeline-id",
            "warn",
            `manifest id "${manifest.id}" differs from pipeline id "${parsed.data.id}"`,
          ),
        );
      }
      return;
    }
    case "template": {
      const raw = await parseFile(entryPath, checks, "template");
      if (!raw) {
        return;
      }
      const parsed = templateDefinitionSchema.safeParse(raw.data);
      if (!parsed.success) {
        checks.push(
          check(
            "template",
            "fail",
            `${manifest.entry} is invalid: ${formatIssues(parsed.error)}`,
          ),
        );
        return;
      }
      checks.push(check("template", "pass", "template definition validates"));
      if (parsed.data.id !== manifest.id) {
        checks.push(
          check(
            "template-id",
            "warn",
            `manifest id "${manifest.id}" differs from template id "${parsed.data.id}"`,
          ),
        );
      }
      return;
    }
    case "source": {
      const raw = await parseFile(entryPath, checks, "source");
      if (!raw) {
        return;
      }
      const parsed = sourceAssetSchema.safeParse(raw.data);
      if (!parsed.success) {
        checks.push(
          check(
            "source",
            "fail",
            `${manifest.entry} is invalid: ${formatIssues(parsed.error)}`,
          ),
        );
        return;
      }
      checks.push(check("source", "pass", "source asset envelope validates"));
      return;
    }
    default: {
      const result = await validateComponentEntry(
        entryPath,
        asComponentKind(manifest.kind),
      );
      if (!result.ok) {
        checks.push(check("component", "fail", result.detail));
        return;
      }
      checks.push(
        check(
          "component",
          "pass",
          `${manifest.kind} component entry validates`,
        ),
      );
      if (result.id && result.id !== manifest.id) {
        checks.push(
          check(
            "component-id",
            "warn",
            `manifest id "${manifest.id}" differs from component name "${result.id}"`,
          ),
        );
      }
    }
  }
}

async function validateComponentEntry(
  entryPath: string,
  kind: ComponentKind,
): Promise<{ ok: true; id: string | null } | { ok: false; detail: string }> {
  const text = await readFile(entryPath, "utf8");
  if (kind === "agent") {
    const { data } = splitFrontmatter(text);
    const parsed = agentFrontmatterSchema.safeParse(data);
    return parsed.success
      ? { ok: true, id: parsed.data.name }
      : {
          ok: false,
          detail: `agent frontmatter is invalid: ${formatIssues(parsed.error)}`,
        };
  }

  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return {
      ok: false,
      detail: `entry is not valid YAML: ${messageOf(error)}`,
    };
  }
  if (kind === "workflow") {
    const parsed = workflowDefinitionSchema.safeParse(data);
    return parsed.success
      ? { ok: true, id: parsed.data.id }
      : {
          ok: false,
          detail: `workflow entry is invalid: ${formatIssues(parsed.error)}`,
        };
  }
  const parsed =
    kind === "toolpack"
      ? toolPackSchema.safeParse(data)
      : skillPackSchema.safeParse(data);
  return parsed.success
    ? { ok: true, id: parsed.data.name }
    : {
        ok: false,
        detail: `${kind} entry is invalid: ${formatIssues(parsed.error)}`,
      };
}

async function parseFile(
  entryPath: string,
  checks: WorkshopPublishCheck[],
  id: string,
): Promise<{ data: unknown } | null> {
  const text = await readFile(entryPath, "utf8");
  try {
    return { data: parse(text) };
  } catch (error) {
    checks.push(
      check(id, "fail", `entry is not valid YAML: ${messageOf(error)}`),
    );
    return null;
  }
}

async function signatureCheck(
  manifest: WorkshopManifest,
): Promise<WorkshopPublishCheck> {
  if (!manifest.signature) {
    return check(
      "signature",
      "warn",
      "unsigned; the item publishes with community trust until signed and verified",
    );
  }
  let keys: WorkshopTrustedKey[] = [];
  try {
    keys = await loadWorkshopTrustedKeys();
  } catch (error) {
    return check(
      "signature",
      "warn",
      `signature present (key ${manifest.signature.keyId}) but the local keyring is unreadable: ${messageOf(error)}`,
    );
  }
  const trust = verifyWorkshopSignature(manifest, keys);
  if (trust.signature === "valid") {
    return check(
      "signature",
      "pass",
      `signed by ${manifest.signature.keyId} (${trust.level})`,
    );
  }
  if (trust.signature === "unknown-key") {
    return check(
      "signature",
      "warn",
      `signed by unknown key ${manifest.signature.keyId}; add it to the keyring to get verified trust`,
    );
  }
  return check(
    "signature",
    "fail",
    `signature by ${manifest.signature.keyId} does not verify`,
  );
}

/**
 * Pick the asset kind from a directory without workshop.yaml. The ordered
 * hints keep a pack winning over embedded components; multiple component
 * entries are ambiguous, so the caller must pass an explicit kind.
 */
function inferKind(files: string[]): WorkshopManifest["kind"] | null {
  if (files.includes("team.yaml")) {
    return "pack";
  }
  if (files.includes(PIPELINE_ENTRY)) {
    return "pipeline";
  }
  if (files.includes(TEMPLATE_ENTRY)) {
    return "template";
  }
  const candidates = COMPONENT_KINDS.filter((kind) =>
    files.includes(componentEntry(kind)),
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function componentEntry(kind: WorkshopManifest["kind"]): string {
  return COMPONENT_ENTRY[asComponentKind(kind)];
}

function asComponentKind(kind: WorkshopManifest["kind"]): ComponentKind {
  if ((COMPONENT_KINDS as readonly string[]).includes(kind)) {
    return kind as ComponentKind;
  }
  throw new PublishFailure(`not a component kind: ${kind}`);
}

function declarativePermissions(context: PublishContext) {
  return {
    network: false,
    filesystem: context.code ? "workspace" : "none",
    code: context.code,
  };
}

function agentPermissions(
  context: PublishContext,
  permissions: { filesystem?: string; network?: string } | undefined,
) {
  const filesystem = permissions?.filesystem;
  return {
    network:
      permissions?.network !== undefined && permissions.network !== "none",
    filesystem:
      filesystem === "none" ||
      filesystem === "readonly" ||
      filesystem === "workspace"
        ? filesystem
        : "none",
    code: context.code,
  };
}

function requireId(value: string, source: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new PublishFailure(
      `${source} "${value}" cannot be used as a workshop id; use a kebab-case id`,
    );
  }
  return value;
}

/**
 * Manifest versions are `x.y.z`; workflows and pipelines commonly use `x.y`,
 * so the publisher normalises those and rejects anything else with a readable
 * message instead of throwing a schema error.
 */
function requireVersion(value: string, source: string): string {
  if (/^\d+\.\d+$/.test(value)) {
    return `${value}.0`;
  }
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    return value;
  }
  throw new PublishFailure(`${source} version "${value}" is not x.y or x.y.z`);
}

async function readYaml(
  context: PublishContext,
  entry: string,
): Promise<unknown> {
  const text = await context.read(entry);
  try {
    return parse(text);
  } catch (error) {
    throw new PublishFailure(`${entry} is not valid YAML: ${messageOf(error)}`);
  }
}

async function readEntry(dir: string, entry: string): Promise<string> {
  const absolute = resolveInside(dir, entry);
  if (!existsSync(absolute)) {
    throw new PublishFailure(`entry file is missing: ${entry}`);
  }
  return readFile(absolute, "utf8");
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
      const text = await readFile(resolveInside(dir, file), "utf8");
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

function parsedKind(value: unknown): WorkshopManifest["kind"] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" &&
    (ASSET_KINDS as readonly string[]).includes(kind)
    ? (kind as WorkshopManifest["kind"])
    : null;
}

function formatIssues(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTextContent(content: Buffer): boolean {
  return !content.subarray(0, 8192).includes(0);
}
