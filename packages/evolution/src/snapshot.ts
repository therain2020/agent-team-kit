import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type HiddenPlan,
  appendHiddenAudit,
  loadHiddenSuite,
  selectHiddenChunk,
} from "./hidden";
import { assertSnapshotRootAllowed } from "./security-invariants";

/**
 * Bump when the judge prompt or scoring logic changes. The evaluator hash
 * combines this version with the frozen evals/, so a changed evaluator
 * requires an explicit high-risk approval before the next cycle runs.
 */
export const EVALUATOR_VERSION = "1";

const MANIFEST_FILE = "manifest.json";
const MANIFEST_HASH_FILE = "manifest.sha256";
const MANIFEST_FILES = new Set([MANIFEST_FILE, MANIFEST_HASH_FILE]);

export interface SnapshotFile {
  path: string;
  sha256: string;
  size: number;
}

export interface EvalSnapshotManifest {
  version: 1;
  cycleId: string;
  createdAt: string;
  packDir: string;
  evaluatorVersion: string;
  evaluatorHash: string;
  sources: SnapshotFile[];
  /**
   * Rotation record for the hidden eval set. `{ available: false }` means the
   * cycle ran with the visible rubric only; `reason` explains why a resolved
   * hidden directory was unusable (70 §5). Older manifests omit the field.
   */
  hidden?: HiddenPlan;
}

export interface EvalSnapshot {
  dir: string;
  manifest: EvalSnapshotManifest;
  manifestHash: string;
}

export interface SnapshotVerification {
  ok: boolean;
  manifestHash: string;
  mismatches: string[];
}

export function defaultCyclesRoot(): string {
  return path.resolve(
    process.env.KIT_EVOLUTION_CYCLES_ROOT ??
      path.join(os.homedir(), ".agent-team-kit", "cycles"),
  );
}

export async function createEvalSnapshot(input: {
  cycleId: string;
  packDir: string;
  cyclesRoot?: string;
  hiddenEvalsDir?: string;
  /**
   * Recorded when the caller resolved a hidden set but it was unavailable
   * (missing directory or missing suite). The manifest keeps the reason so a
   * visible-only cycle is explicit rather than a silent fallback (70 §5).
   */
  hiddenUnavailable?: { reason: string };
  workspaceId?: string;
  /** Rotation clock; tests pin it to exercise the time-based rotation. */
  now?: Date;
  freeze?: boolean;
  expectedEvaluatorHash?: string;
  /**
   * External kit home (`KIT_HOME`, default `~/.agent-team-kit`). When supplied,
   * the snapshot root must live inside it (SEC-INV-03); otherwise the cycle
   * refuses to write the frozen eval snapshot.
   */
  kitHome?: string;
}): Promise<EvalSnapshot> {
  const packDir = path.resolve(input.packDir);
  const cyclesRoot = path.resolve(input.cyclesRoot ?? defaultCyclesRoot());
  assertOutside(cyclesRoot, packDir, "pack directory");
  assertOutside(cyclesRoot, process.cwd(), "repository");
  if (input.kitHome) {
    assertSnapshotRootAllowed({
      cyclesRoot,
      kitHome: input.kitHome,
      repoRoot: path.resolve(process.cwd()),
    });
  }

  const evalsDir = path.join(packDir, "evals");
  if (!existsSync(evalsDir)) {
    throw new Error(`pack has no evals/ directory to freeze: ${packDir}`);
  }

  const dir = path.join(cyclesRoot, input.cycleId, "eval");
  if (existsSync(dir)) {
    throw new Error(`eval snapshot already exists: ${dir}`);
  }
  await mkdir(dir, { recursive: true });

  await cp(evalsDir, path.join(dir, "evals"), { recursive: true });

  const fixturesDir = path.join(packDir, "fixtures");
  if (existsSync(fixturesDir)) {
    await cp(fixturesDir, path.join(dir, "fixtures"), { recursive: true });
  }

  let hidden: HiddenPlan = input.hiddenUnavailable
    ? {
        available: false,
        reason: input.hiddenUnavailable.reason,
        checkedAt: new Date().toISOString(),
      }
    : { available: false };
  if (input.hiddenEvalsDir) {
    const hiddenDir = path.resolve(input.hiddenEvalsDir);
    if (!existsSync(hiddenDir)) {
      throw new Error(`hidden evals directory missing: ${hiddenDir}`);
    }
    if (isInside(dir, hiddenDir)) {
      throw new Error(
        `hidden evals directory must not be inside the snapshot destination: ${hiddenDir}`,
      );
    }
    if (isInside(packDir, hiddenDir)) {
      throw new Error(
        `hidden evals directory must live outside the pack: ${hiddenDir}`,
      );
    }
    if (isInside(process.cwd(), hiddenDir)) {
      throw new Error(
        `hidden evals directory must live outside the repository: ${hiddenDir}`,
      );
    }
    const rotatedAt = (input.now ?? new Date()).toISOString();
    const suite = await loadHiddenSuite(hiddenDir);
    const selection = selectHiddenChunk(suite, input.now);
    await appendHiddenAudit(cyclesRoot, {
      at: rotatedAt,
      action: "select",
      cycleId: input.cycleId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      suiteHash: selection.suiteHash,
      rotationEpoch: selection.rotationEpoch,
      selectedCaseIds: selection.selectedCaseIds,
    });
    await cp(hiddenDir, path.join(dir, "hidden"), { recursive: true });
    hidden = { available: true, rotatedAt, ...selection };
  }

  const sources = await hashTree(dir);
  const manifest: EvalSnapshotManifest = {
    version: 1,
    cycleId: input.cycleId,
    createdAt: new Date().toISOString(),
    packDir,
    evaluatorVersion: EVALUATOR_VERSION,
    evaluatorHash: evaluatorHashOf(sources),
    sources,
    hidden,
  };
  if (
    input.expectedEvaluatorHash &&
    manifest.evaluatorHash !== input.expectedEvaluatorHash
  ) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      "evaluator changed while freezing the snapshot; retry the cycle",
    );
  }

  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(dir, MANIFEST_FILE), manifestBytes);
  const manifestHash = sha256(manifestBytes);
  await writeFile(
    path.join(dir, MANIFEST_HASH_FILE),
    `${manifestHash}\n`,
    "utf8",
  );

  if (input.freeze ?? true) {
    await freezeTree(dir);
  }

  return { dir, manifest, manifestHash };
}

export async function evaluatorHashForPack(packDir: string): Promise<string> {
  const evalsDir = path.join(path.resolve(packDir), "evals");
  if (!existsSync(evalsDir)) {
    throw new Error(`pack has no evals/ directory to freeze: ${packDir}`);
  }
  const files = (await hashTree(evalsDir)).map((file) => ({
    ...file,
    path: `evals/${file.path}`,
  }));
  return evaluatorHashOf(files);
}

export async function verifyEvalSnapshot(
  dir: string,
): Promise<SnapshotVerification> {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`eval snapshot manifest missing: ${root}`);
  }

  const manifestBytes = await readFile(manifestPath);
  const manifestHash = sha256(manifestBytes);
  const mismatches: string[] = [];

  const hashPath = path.join(root, MANIFEST_HASH_FILE);
  if (!existsSync(hashPath)) {
    mismatches.push(MANIFEST_HASH_FILE);
  } else {
    const recorded = (await readFile(hashPath, "utf8")).trim();
    if (recorded !== manifestHash) {
      mismatches.push(MANIFEST_HASH_FILE);
    }
  }

  let manifest: EvalSnapshotManifest;
  try {
    manifest = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as EvalSnapshotManifest;
  } catch {
    return {
      ok: false,
      manifestHash,
      mismatches: [...mismatches, MANIFEST_FILE],
    };
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.sources)) {
    return {
      ok: false,
      manifestHash,
      mismatches: [...mismatches, MANIFEST_FILE],
    };
  }

  const actual = new Map(
    (await hashTree(root)).map((file) => [file.path, file]),
  );
  const expectedPaths = new Set<string>();
  for (const expected of manifest.sources) {
    expectedPaths.add(expected.path);
    const got = actual.get(expected.path);
    if (!got || got.sha256 !== expected.sha256 || got.size !== expected.size) {
      mismatches.push(expected.path);
    }
  }
  for (const got of actual.values()) {
    if (!expectedPaths.has(got.path)) {
      mismatches.push(`unexpected:${got.path}`);
    }
  }

  return { ok: mismatches.length === 0, manifestHash, mismatches };
}

export async function readEvalSnapshotManifest(
  dir: string,
): Promise<EvalSnapshot> {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`eval snapshot manifest missing: ${root}`);
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(
    manifestBytes.toString("utf8"),
  ) as EvalSnapshotManifest;
  return { dir: root, manifest, manifestHash: sha256(manifestBytes) };
}

export async function loadEvalSnapshot(
  cyclesRoot: string,
  cycleId: string,
): Promise<EvalSnapshot | null> {
  const dir = path.join(path.resolve(cyclesRoot), cycleId, "eval");
  if (!existsSync(path.join(dir, MANIFEST_FILE))) {
    return null;
  }
  return await readEvalSnapshotManifest(dir);
}

export async function findPreviousEvalSnapshot(input: {
  cyclesRoot: string;
  excludeCycleId: string;
  packDir?: string;
}): Promise<EvalSnapshot | null> {
  const root = path.resolve(input.cyclesRoot);
  if (!existsSync(root)) {
    return null;
  }

  const packDir = input.packDir ? path.resolve(input.packDir) : undefined;
  const snapshots: EvalSnapshot[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === input.excludeCycleId) {
      continue;
    }
    const snapshot = await loadEvalSnapshot(root, entry.name);
    if (snapshot && (!packDir || snapshot.manifest.packDir === packDir)) {
      snapshots.push(snapshot);
    }
  }

  snapshots.sort((a, b) =>
    a.manifest.createdAt.localeCompare(b.manifest.createdAt),
  );
  return snapshots.at(-1) ?? null;
}

function evaluatorHashOf(sources: SnapshotFile[]): string {
  const lines = sources
    .filter((file) => file.path.startsWith("evals/"))
    .map((file) => `${file.path}:${file.sha256}`)
    .sort();
  return sha256(
    Buffer.from(`${EVALUATOR_VERSION}\n${lines.join("\n")}\n`, "utf8"),
  );
}

async function hashTree(
  root: string,
  dir: string = root,
): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await hashTree(root, full)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (MANIFEST_FILES.has(relative)) {
      continue;
    }
    const bytes = await readFile(full);
    files.push({
      path: relative,
      sha256: sha256(bytes),
      size: (await stat(full)).size,
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function freezeTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await freezeTree(full);
    } else if (entry.isFile()) {
      await bestEffortChmod(full, 0o444);
    }
  }
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs may ignore POSIX modes; hash verification is the hard guard.
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertOutside(target: string, forbidden: string, label: string): void {
  if (isInside(forbidden, target)) {
    throw new Error(
      `eval snapshot must live outside the ${label} (${target} is inside ${forbidden})`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
