import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

/**
 * Hidden eval suites live outside the repository (and outside every pack):
 *
 *   <hidden-root>/<workspace>/suite.yaml
 *
 * The default root is `~/.agent-team-kit/hidden-evals`; override it with
 * `KIT_HIDDEN_EVALS_ROOT`. Cases never enter packs, variants, logs or the
 * console - only aggregate counts leave the scoring path. Every read or
 * selection is written to the external audit sink
 * `<cycles-root>/hidden-audit.jsonl`.
 *
 * Cases rotate on a fixed time window: the suite is shuffled by a stable hash
 * and split into disjoint chunks; each rotation epoch selects exactly one
 * chunk. A case from the previous epoch is therefore never judged in the new
 * epoch, so tuning against one subset does not leak into the next.
 */

export const HIDDEN_SUITE_FILE = "suite.yaml";
export const DEFAULT_HIDDEN_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HiddenCaseKind = "standard" | "adversarial";

export interface HiddenCaseExpectation {
  /** Every string must appear in the produced draft (case-sensitive). */
  contains: string[];
  /** None of the strings may appear in the produced draft. */
  excludes: string[];
}

export interface HiddenCase {
  id: string;
  kind: HiddenCaseKind;
  /** Evidence handed to the agent under test. Never leaves the hidden tree. */
  evidence: string;
  expect: HiddenCaseExpectation;
}

export interface HiddenSuite {
  version: 1;
  rotation: { periodDays: number; size: number; seed?: string };
  cases: HiddenCase[];
  suiteHash: string;
  dir: string;
}

export interface HiddenRotationSelection {
  suiteHash: string;
  rotationEpoch: number;
  periodDays: number;
  chunkIndex: number;
  chunkCount: number;
  caseCount: number;
  selectedCaseIds: string[];
}

export type HiddenPlan =
  | { available: false }
  | ({ available: true; rotatedAt: string } & HiddenRotationSelection);

export interface HiddenCoverage {
  available: boolean;
  total: number;
  passed: number;
  failed: number;
  adversarialFailed: number;
}

export interface HiddenAuditEvent {
  at: string;
  action: "select" | "score";
  cycleId: string;
  workspaceId?: string;
  suiteHash: string;
  rotationEpoch: number;
  selectedCaseIds: string[];
}

export const EMPTY_HIDDEN_COVERAGE: HiddenCoverage = {
  available: false,
  total: 0,
  passed: 0,
  failed: 0,
  adversarialFailed: 0,
};

export function defaultHiddenEvalsRoot(): string {
  return path.resolve(
    process.env.KIT_HIDDEN_EVALS_ROOT ??
      path.join(os.homedir(), ".agent-team-kit", "hidden-evals"),
  );
}

/**
 * `<hidden-root>/<workspace>`. The workspace segment is sanitized so a
 * workspace id can never escape the hidden root.
 */
export function defaultHiddenEvalsDir(
  workspaceId: string,
  root?: string,
): string {
  const safe = workspaceId.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  const segment =
    safe === "" || safe === "." || safe === ".." ? "default" : safe;
  return path.join(path.resolve(root ?? defaultHiddenEvalsRoot()), segment);
}

export async function loadHiddenSuite(dir: string): Promise<HiddenSuite> {
  const root = path.resolve(dir);
  const file = path.join(root, HIDDEN_SUITE_FILE);
  if (!existsSync(file)) {
    throw new Error(`hidden eval suite missing: ${file}`);
  }
  const bytes = await readFile(file);
  return parseHiddenSuite(bytes.toString("utf8"), {
    dir: root,
    suiteHash: sha256(bytes),
  });
}

export function parseHiddenSuite(
  text: string,
  meta: { dir?: string; suiteHash?: string } = {},
): HiddenSuite {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`hidden eval suite is not valid YAML: ${message}`);
  }
  if (!isRecord(doc)) {
    throw new Error("hidden eval suite must be a mapping");
  }
  if (doc.version !== 1) {
    const version = String(doc.version);
    throw new Error(`hidden eval suite version must be 1: ${version}`);
  }
  const cases = parseCases(doc.cases);
  const rotation = parseRotation(doc.rotation, cases.length);
  const suiteHash = meta.suiteHash ?? sha256(Buffer.from(text, "utf8"));
  return {
    version: 1,
    rotation,
    cases,
    suiteHash,
    dir: meta.dir ?? "",
  };
}

export function selectHiddenChunk(
  suite: HiddenSuite,
  now: Date = new Date(),
): HiddenRotationSelection {
  const { periodDays, size, seed } = suite.rotation;
  const epoch = Math.floor(now.getTime() / (periodDays * DAY_MS));
  const salt = seed ?? suite.suiteHash;
  const ordered = [...suite.cases].sort((a, b) =>
    compareHashes(salt, a.id, b.id),
  );

  const chunks: string[][] = [];
  for (let index = 0; index < ordered.length; index += size) {
    chunks.push(ordered.slice(index, index + size).map((item) => item.id));
  }
  const chunkIndex = epoch % chunks.length;
  const selectedCaseIds = chunks[chunkIndex] ?? [];
  return {
    suiteHash: suite.suiteHash,
    rotationEpoch: epoch,
    periodDays,
    chunkIndex,
    chunkCount: chunks.length,
    caseCount: suite.cases.length,
    selectedCaseIds,
  };
}

export function checkHiddenDraft(
  draft: string,
  expectation: HiddenCaseExpectation,
): boolean {
  for (const expected of expectation.contains) {
    if (!draft.includes(expected)) {
      return false;
    }
  }
  for (const forbidden of expectation.excludes) {
    if (draft.includes(forbidden)) {
      return false;
    }
  }
  return true;
}

export function hiddenAuditPath(cyclesRoot: string): string {
  return path.join(path.resolve(cyclesRoot), "hidden-audit.jsonl");
}

/**
 * Append one audit event. Failures propagate: an access that cannot be audited
 * is denied rather than silently unrecorded.
 */
export async function appendHiddenAudit(
  cyclesRoot: string,
  event: HiddenAuditEvent,
): Promise<void> {
  const file = hiddenAuditPath(cyclesRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * The snapshot lives at `<cycles-root>/<cycleId>/eval`; the audit sink is the
 * root two levels up, outside the frozen tree.
 */
export function auditRootForSnapshot(evalDir: string): string {
  return path.dirname(path.dirname(path.resolve(evalDir)));
}

function compareHashes(salt: string, a: string, b: string): number {
  const left = sha256(Buffer.from(`${salt}:${a}`, "utf8"));
  const right = sha256(Buffer.from(`${salt}:${b}`, "utf8"));
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return a.localeCompare(b);
}

function parseCases(raw: unknown): HiddenCase[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("hidden eval suite needs a non-empty cases list");
  }
  const ids = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`hidden case ${index} must be a mapping`);
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) {
      throw new Error(`hidden case ${index} needs a non-empty id`);
    }
    if (ids.has(id)) {
      throw new Error(`duplicate hidden case id: ${id}`);
    }
    ids.add(id);
    const kind = item.kind ?? "standard";
    if (kind !== "standard" && kind !== "adversarial") {
      throw new Error(
        `hidden case ${id}: kind must be "standard" or "adversarial"`,
      );
    }
    const evidence = typeof item.evidence === "string" ? item.evidence : "";
    if (!evidence.trim()) {
      throw new Error(`hidden case ${id} needs evidence`);
    }
    return {
      id,
      kind,
      evidence,
      expect: parseExpectation(item.expect, id),
    };
  });
}

function parseExpectation(raw: unknown, id: string): HiddenCaseExpectation {
  if (raw === undefined) {
    return { contains: [], excludes: [] };
  }
  if (!isRecord(raw)) {
    throw new Error(`hidden case ${id}: expect must be a mapping`);
  }
  return {
    contains: parseStringList(raw.contains, `${id}: expect.contains`),
    excludes: parseStringList(raw.excludes, `${id}: expect.excludes`),
  };
}

function parseStringList(raw: unknown, label: string): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`hidden case ${label} must be a list of strings`);
  }
  return raw.map((value, index) => {
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `hidden case ${label}[${index}] must be a non-empty string`,
      );
    }
    return value;
  });
}

function parseRotation(
  raw: unknown,
  caseCount: number,
): HiddenSuite["rotation"] {
  const fallback = {
    periodDays: DEFAULT_HIDDEN_PERIOD_DAYS,
    size: caseCount,
  };
  if (raw === undefined) {
    return fallback;
  }
  if (!isRecord(raw)) {
    throw new Error("hidden eval suite rotation must be a mapping");
  }
  const periodDays = raw.periodDays ?? fallback.periodDays;
  if (!isPositiveInteger(periodDays)) {
    throw new Error("hidden rotation.periodDays must be a positive integer");
  }
  const size = raw.size ?? fallback.size;
  if (!isPositiveInteger(size)) {
    throw new Error("hidden rotation.size must be a positive integer");
  }
  if (size > caseCount) {
    throw new Error(
      `hidden rotation.size ${size} exceeds the ${caseCount} cases in the suite`,
    );
  }
  const seed = raw.seed;
  if (seed !== undefined && (typeof seed !== "string" || seed === "")) {
    throw new Error("hidden rotation.seed must be a non-empty string");
  }
  return {
    periodDays,
    size,
    ...(typeof seed === "string" ? { seed } : {}),
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
