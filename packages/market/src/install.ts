import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem helpers shared by every market install (plan 88 §4, D-69).
 *
 * Installs stage next to the target, validate in place, then swap atomically;
 * a failed install never leaves a partial directory and an overwrite never
 * destroys the previous copy until the new one is ready. The same helpers
 * write manifests and install records so sources and packs behave identically.
 */

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** True when a manifest-relative path cannot escape or address the root. */
export function isSafeRelPath(relative: string): boolean {
  return SAFE_RELATIVE_PATH.test(relative);
}

/** Resolve `relative` under `root`, throwing if it would escape. */
export function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe market path: ${relative}`);
  }
  return resolved;
}

/** Write a file by renaming a sibling temp file, so readers never see a half. */
export async function writeFileAtomic(
  file: string,
  content: string,
): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

/** Write a JSON install record atomically (2-space indented). */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** Read a JSON record, returning `null` when it is missing or unparsable. */
export async function readJsonFile<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Swap a validated staging directory into `target`. An existing target is moved
 * aside first and restored if the swap fails; nothing is deleted until the new
 * copy is in place.
 */
export async function commitStagedDir(input: {
  staging: string;
  target: string;
  id: string;
}): Promise<void> {
  const { staging, target, id } = input;
  let backup: string | null = null;
  try {
    if (existsSync(target)) {
      backup = path.join(
        path.dirname(target),
        `.${id}.replacing-${randomUUID()}`,
      );
      await rename(target, backup);
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (backup && !existsSync(target)) {
      // Restore the previous copy; if even that fails the backup stays on disk
      // for manual recovery and the original error is surfaced.
      await rename(backup, target).catch(() => undefined);
    }
    throw error;
  }
  if (backup) {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Unique sibling name for a staged install/replace of `id`. */
export function stagingName(root: string, id: string, suffix: string): string {
  return path.join(root, `.${id}.${suffix}-${randomUUID()}`);
}
