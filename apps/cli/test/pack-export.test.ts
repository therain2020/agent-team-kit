import { readFile } from "node:fs/promises";
import { loadPack } from "@kit/pack";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { exportPack } from "../src/pack-export";

describe("pack export", () => {
  it("exports a zip with a hashed manifest", async () => {
    const loaded = await loadPack("packs/tech-radar");
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("\n"));
    }

    const out = ".tmp/tech-radar-export-test.zip";
    const result = await exportPack(loaded, out);
    const buffer = await readFile(out);
    const zip = await JSZip.loadAsync(buffer);

    const manifestFile = zip.file("pack.manifest.json");
    expect(manifestFile).toBeTruthy();
    if (!manifestFile) {
      throw new Error("manifest missing");
    }

    const manifest = JSON.parse(await manifestFile.async("string")) as {
      name: string;
      files: Array<{ path: string; sha256: string }>;
    };

    expect(manifest.name).toBe("tech-radar");
    expect(result.files).toBeGreaterThan(0);

    const teamFile = manifest.files.find((file) => file.path === "team.yaml");
    expect(teamFile?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(zip.file("agents/writer.md")).toBeTruthy();
    expect(zip.file("workflows/daily-radar.yaml")).toBeTruthy();
  });
});
