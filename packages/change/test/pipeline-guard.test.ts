import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static bypass guard for the unified change pipeline.
 *
 * The 86 single-writer invariant only holds while apply/promote have a single
 * entry: the `kit-apply` queue (and the locked manual apply path). If new code
 * starts calling the low-level apply/promote primitives directly, the change
 * pipeline and its audit trail are silently bypassed.
 *
 * This test fails whenever a call site appears outside the reviewed allowlist.
 * Adding a new entry means either routing through `@kit/change` or updating
 * this list with a documented reason — the review is the point.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-bench",
  ".next-prod",
  ".tmp",
  "dist",
  "build",
  "coverage",
  "variants",
  ".claude",
  ".gstack",
  ".backup",
  "test",
  "tests",
  "__tests__",
]);

/** Reviewed direct call sites. Everything else must go through @kit/change. */
const ALLOWED_CALL_SITES: Record<string, readonly string[]> = {
  applyPatchToRepo: ["packages/iteration/src/apply.ts"],
  applyDiffToRepo: [
    "packages/engine/src/iteration-activities.ts",
    "packages/job/src/pending.ts",
  ],
  promoteVariant: [
    "packages/evolution/src/cycle.ts",
    "apps/cli/src/commands/evolve.ts",
    "apps/web/app/api/evolution/promote/route.ts",
  ],
};

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const top of ["packages", "apps"]) {
    const dir = path.join(repoRoot, top);
    for (const pkg of readdirSync(dir)) {
      walk(path.join(dir, pkg), files);
    }
  }
  walk(path.join(repoRoot, "scripts"), files);
  return files;
}

function relative(file: string): string {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function callSites(name: string): string[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`);
  const definition = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
  const sites = new Set<string>();
  for (const file of sourceFiles()) {
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (pattern.test(line) && !definition.test(line)) {
        sites.add(relative(file));
      }
    }
  }
  return [...sites].sort();
}

describe("change pipeline bypass guard", () => {
  it("keeps apply/promote call sites on the reviewed allowlist", () => {
    for (const [name, allowed] of Object.entries(ALLOWED_CALL_SITES)) {
      expect(callSites(name), `direct ${name} call sites`).toEqual(
        [...allowed].sort(),
      );
    }
  });

  it("keeps @kit/change free of apply/promote dependencies", () => {
    const changeSrc = walk(path.join(repoRoot, "packages/change/src"));
    for (const file of changeSrc) {
      const content = readFileSync(file, "utf8");
      expect(content, relative(file)).not.toMatch(
        /from\s+"@kit\/(iteration|evolution|engine|job)"/,
      );
    }
  });

  it("keeps the apply worker at concurrency 1", () => {
    const worker = readFileSync(
      path.join(repoRoot, "apps/runtime/src/temporal/worker.ts"),
      "utf8",
    );
    const start = worker.indexOf("const applyWorker = await Worker.create({");
    expect(start).toBeGreaterThan(-1);
    const block = worker.slice(start, worker.indexOf("});", start));
    expect(block).toContain("taskQueue: applyTaskQueue");
    expect(block).toContain("applyIterationTask");
    expect(block).toMatch(/maxConcurrentActivityTaskExecutions:\s*1\b/);
  });
});
