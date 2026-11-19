import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkColdStartPackage } from "./cold-start-check";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageDir = path.join(repoRoot, "templates", "cold-start");

describe("cold-start-check", () => {
  it("accepts the shipped cold-start package", () => {
    const report = checkColdStartPackage(packageDir);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reports missing files and fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kit-cold-start-"));
    try {
      const report = checkColdStartPackage(dir);
      expect(report.ok).toBe(false);
      expect(report.missing).toContain("README.md");
      const budget = report.checks.find((check) => check.id === "budget");
      expect(budget?.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
