#!/usr/bin/env bun
/**
 * Compose gate (plan 94 §2 rule 6, §6 C-0).
 *
 * A new or changed user input surface must ship with a compose kind, a
 * deterministic fallback (`heuristic`) and the intent → draft → edit → approve
 * review step. The declaration lives in `.github/compose-gate/input-surfaces.json`
 * so it is versioned and reviewable in the same PR instead of being prose in an
 * ephemeral PR body.
 *
 * Detection scope is deliberately narrow (see docs/compose-gate.md):
 *   1. `apps/web/components/<domain>/<name>-(dialog|wizard|form).tsx`
 *      (`components/ui` and `components/kit` primitives are excluded);
 *   2. any tsx file under `apps/web/` whose content calls `/api/compose`.
 * Pages, API routes, packages, docs, tests and generic UI are not input
 * surfaces for this gate, so unrelated PRs always pass.
 *
 * Usage:
 *   bun run scripts/compose-gate.ts --base origin/develop
 *   bun run scripts/compose-gate.ts --files changed.txt
 *   bun run scripts/compose-gate.ts --audit
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPOSE_KINDS = [
  "mission",
  "packRun",
  "approvalPolicy",
  "autopilot",
  "evolutionCycle",
  "agent",
  "pack",
  "workflow",
  "pipeline",
  "source",
  "studio.member",
  "studio.workflow",
] as const;

export type ComposeKind = (typeof COMPOSE_KINDS)[number];

/** Plan 94 §2 rule 3: no model → deterministic draft labeled `model: heuristic`. */
export const REQUIRED_FALLBACK = "heuristic";
/** Plan 94 §2 rules 1, 4 and 6: the review step is fixed, not free prose. */
export const REQUIRED_REVIEW = "intent-draft-edit-approve";

export const MANIFEST_PATH = ".github/compose-gate/input-surfaces.json";

const COMPOSE_KIND_SET: ReadonlySet<string> = new Set(COMPOSE_KINDS);
const DIALOG_LIKE = /^[^/]+-(?:dialog|wizard|form)\.tsx$/;
const WEB_COMPONENTS = "apps/web/components/";
const WEB_SOURCE_DIRS = ["apps/web/components", "apps/web/app"];

export interface ComposeSurface {
  id: string;
  label: string;
  files: string[];
  status: "compose" | "exempt";
  composeKinds?: ComposeKind[];
  fallback?: typeof REQUIRED_FALLBACK;
  review?: typeof REQUIRED_REVIEW;
  reason?: string;
}

export interface ComposeManifest {
  version: 1;
  description?: string;
  surfaces: ComposeSurface[];
}

export interface ManifestValidation {
  manifest: ComposeManifest | null;
  errors: string[];
}

export interface EvaluateOptions {
  manifest: unknown;
  changedFiles: string[];
  readFile: (file: string) => string | null;
}

export interface GateReport {
  ok: boolean;
  errors: string[];
  covered: string[];
  uncovered: string[];
}

export function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Rule 1 of the detection scope: a dialog, wizard or form component directly
 * under a console domain. Shared primitives (`ui/`, `kit/`) are not surfaces.
 */
export function isDialogLikeSurface(raw: string): boolean {
  const file = normalizePath(raw);
  if (!file.startsWith(WEB_COMPONENTS)) {
    return false;
  }
  if (
    file.startsWith(`${WEB_COMPONENTS}ui/`) ||
    file.startsWith(`${WEB_COMPONENTS}kit/`)
  ) {
    return false;
  }
  const base = file.split("/").pop() ?? "";
  return DIALOG_LIKE.test(base);
}

/** Rule 2: any console client that talks to the compose API is a surface. */
export function postsToCompose(raw: string, content: string): boolean {
  const file = normalizePath(raw);
  return (
    file.startsWith("apps/web/") &&
    file.endsWith(".tsx") &&
    content.includes("/api/compose")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isInvalidPath(file: string): boolean {
  return (
    file === "" ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    file.split("/").includes("..") ||
    /[*?[\]]/.test(file)
  );
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      return null;
    }
    items.push(item);
  }
  return items;
}

/**
 * Validate the schema and the D-64 contract of the declaration manifest.
 * A surface is either a compose surface (kind(s) + deterministic fallback +
 * fixed review step) or an explicit exemption with a written reason.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const record = asRecord(raw);
  if (!record) {
    return { manifest: null, errors: ["manifest: root must be a JSON object"] };
  }
  if (record.version !== 1) {
    errors.push("manifest: version must be 1");
  }
  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0) {
    return {
      manifest: null,
      errors: [...errors, "manifest: surfaces must be a non-empty array"],
    };
  }

  const surfaces: ComposeSurface[] = [];
  const seenIds = new Set<string>();
  const seenFiles = new Map<string, string>();

  for (const [index, item] of record.surfaces.entries()) {
    const scope = `manifest: surfaces[${index}]`;
    const entry = asRecord(item);
    if (!entry) {
      errors.push(`${scope} must be an object`);
      continue;
    }
    let valid = true;

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") {
      errors.push(`${scope}.id is required`);
      valid = false;
    } else if (seenIds.has(id)) {
      errors.push(`${scope}.id "${id}" is duplicated`);
      valid = false;
    } else {
      seenIds.add(id);
    }

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (label === "") {
      errors.push(`${scope}.label is required`);
      valid = false;
    }

    const files = stringArray(entry.files);
    if (!files) {
      errors.push(`${scope}.files must be a non-empty array of paths`);
      valid = false;
    }
    const normalizedFiles: string[] = [];
    for (const rawFile of files ?? []) {
      const file = normalizePath(rawFile);
      if (isInvalidPath(file)) {
        errors.push(
          `${scope}.files contains an invalid path "${rawFile}" (use repo-relative paths, no globs)`,
        );
        valid = false;
        continue;
      }
      const owner = seenFiles.get(file);
      if (owner !== undefined) {
        errors.push(
          `${scope}.files: "${file}" is already declared by surface "${owner}"`,
        );
        valid = false;
        continue;
      }
      seenFiles.set(file, id === "" ? scope : id);
      normalizedFiles.push(file);
    }

    if (entry.status === "compose") {
      const kinds = stringArray(entry.composeKinds);
      if (!kinds) {
        errors.push(`${scope}.composeKinds must be a non-empty array`);
        valid = false;
      } else {
        for (const kind of kinds) {
          if (!COMPOSE_KIND_SET.has(kind)) {
            errors.push(
              `${scope}.composeKinds: unknown kind "${kind}" (expected one of ${COMPOSE_KINDS.join(", ")})`,
            );
            valid = false;
          }
        }
      }
      if (entry.fallback !== REQUIRED_FALLBACK) {
        errors.push(`${scope}.fallback must be "${REQUIRED_FALLBACK}"`);
        valid = false;
      }
      if (entry.review !== REQUIRED_REVIEW) {
        errors.push(`${scope}.review must be "${REQUIRED_REVIEW}"`);
        valid = false;
      }
      if (valid) {
        surfaces.push({
          id,
          label,
          files: normalizedFiles,
          status: "compose",
          composeKinds: kinds as ComposeKind[],
          fallback: REQUIRED_FALLBACK,
          review: REQUIRED_REVIEW,
        });
      }
      continue;
    }

    if (entry.status === "exempt") {
      const reason =
        typeof entry.reason === "string" ? entry.reason.trim() : "";
      if (reason === "") {
        errors.push(
          `${scope}.reason is required when status is "exempt" (explain the D-64 exception)`,
        );
        valid = false;
      }
      if (
        entry.composeKinds !== undefined ||
        entry.fallback !== undefined ||
        entry.review !== undefined
      ) {
        errors.push(
          `${scope}: an exempt surface must not declare composeKinds/fallback/review`,
        );
        valid = false;
      }
      if (valid) {
        surfaces.push({
          id,
          label,
          files: normalizedFiles,
          status: "exempt",
          reason,
        });
      }
      continue;
    }

    errors.push(`${scope}.status must be "compose" or "exempt"`);
  }

  if (errors.length > 0) {
    return { manifest: null, errors };
  }
  return {
    manifest: {
      version: 1,
      description:
        typeof record.description === "string" ? record.description : undefined,
      surfaces,
    },
    errors,
  };
}

/**
 * Detect changed input surfaces and require each one to be declared. Only
 * files that exist at HEAD are classified: a deleted surface is handled by the
 * staleness check on its manifest entry, not by asking for a new declaration.
 */
export function evaluateComposeGate(options: EvaluateOptions): GateReport {
  const validation = validateManifest(options.manifest);
  const errors = [...validation.errors];
  const report: GateReport = { ok: false, errors, covered: [], uncovered: [] };
  const manifest = validation.manifest;
  if (!manifest) {
    return report;
  }

  const declared = new Map<string, ComposeSurface>();
  for (const surface of manifest.surfaces) {
    for (const file of surface.files) {
      declared.set(file, surface);
      if (options.readFile(file) === null) {
        errors.push(
          `${file}: declared by surface "${surface.id}" but the file does not exist; update ${MANIFEST_PATH} in this PR`,
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const raw of [...options.changedFiles].sort()) {
    const file = normalizePath(raw);
    if (file === "" || seen.has(file)) {
      continue;
    }
    seen.add(file);
    const content = options.readFile(file);
    if (content === null) {
      continue;
    }
    if (!isDialogLikeSurface(file) && !postsToCompose(file, content)) {
      continue;
    }
    if (declared.has(file)) {
      report.covered.push(file);
    } else {
      report.uncovered.push(file);
      errors.push(
        `${file}: input surface has no declaration in ${MANIFEST_PATH} (plan 94 §2 rule 6, §6 C-0)`,
      );
    }
  }

  report.ok = errors.length === 0;
  return report;
}

/** Every console source file; used by `--audit` and by the completeness test. */
export function collectWebSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".tsx")) {
        files.push(normalizePath(path.relative(repoRoot, full)));
      }
    }
  };
  for (const dir of WEB_SOURCE_DIRS) {
    const full = path.join(repoRoot, dir);
    if (existsSync(full)) {
      walk(full);
    }
  }
  return files.sort();
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const USAGE = `compose-gate (plan 94 C-0)

Detects changed user input surfaces and requires them to be declared in
${MANIFEST_PATH}.

Options:
  --base <ref>        git ref to diff against (default: origin/develop)
  --files <path>      read changed paths from a newline-separated file
  --audit             check every apps/web source file, not just a diff
  --manifest <path>   manifest to validate (default: ${MANIFEST_PATH})
  --help              show this message`;

function flagValue(argv: string[], flag: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function gitChangedFiles(repoRoot: string, base: string): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line))
    .filter((line) => line !== "");
}

/** Windows editors may prepend a BOM; never fail a gate on it. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readFileList(listPath: string): string[] {
  return stripBom(readFileSync(listPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => normalizePath(line))
    .filter((line) => line !== "");
}

function readWorkspaceFile(repoRoot: string, file: string): string | null {
  const full = path.join(repoRoot, file);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCli(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const manifestPath = path.resolve(
    REPO_ROOT,
    flagValue(argv, "--manifest") ?? MANIFEST_PATH,
  );
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(stripBom(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    console.error(
      `compose-gate: cannot read ${manifestPath}: ${messageOf(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  let changedFiles: string[];
  try {
    const listPath = flagValue(argv, "--files");
    if (argv.includes("--audit")) {
      changedFiles = collectWebSourceFiles(REPO_ROOT);
    } else if (listPath) {
      changedFiles = readFileList(path.resolve(REPO_ROOT, listPath));
    } else {
      changedFiles = gitChangedFiles(
        REPO_ROOT,
        flagValue(argv, "--base") ?? "origin/develop",
      );
    }
  } catch (error) {
    console.error(
      `compose-gate: cannot list changed files: ${messageOf(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  const report = evaluateComposeGate({
    manifest: rawManifest,
    changedFiles,
    readFile: (file) => readWorkspaceFile(REPO_ROOT, file),
  });

  if (report.ok) {
    console.log(
      `compose-gate: ok — ${report.covered.length} declared surface(s) in scope, ${changedFiles.length} file(s) checked`,
    );
    return;
  }

  console.error(
    `compose-gate: FAILED — ${report.errors.length} problem(s) (plan 94 §2 rule 6, §6 C-0)`,
  );
  for (const error of report.errors) {
    console.error(`  - ${error}`);
  }
  console.error("");
  console.error("How to fix:");
  console.error(
    `  1. Declare the surface in ${MANIFEST_PATH} in this PR, for example:`,
  );
  for (const file of report.uncovered) {
    console.error(
      `     { "id": "<plan id>", "label": "<surface>", "files": ["${file}"],`,
    );
    console.error(
      '       "status": "compose", "composeKinds": ["<compose kind>"],',
    );
    console.error(
      `       "fallback": "${REQUIRED_FALLBACK}", "review": "${REQUIRED_REVIEW}" }`,
    );
  }
  console.error(
    '  2. A surface that intentionally stays manual-only needs "status": "exempt" and a written "reason".',
  );
  console.error(
    "  3. The review step is intent → draft → edit → approve; see docs/compose-gate.md.",
  );
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (invokedPath !== undefined &&
    path.resolve(invokedPath) === fileURLToPath(import.meta.url));

if (isMain) {
  runCli();
}
