import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedPack } from "@kit/pack";
import JSZip from "jszip";

const CONTENT_DIRS = ["agents", "skills", "workflows", "policies", "evals"];

export interface PackManifest {
  name: string;
  version: string;
  apiVersion: string;
  kitCompatibility: string;
  exportedAt: string;
  files: Array<{ path: string; sha256: string }>;
}

export async function exportPack(
  loaded: LoadedPack,
  outInput: string,
): Promise<{
  outFile: string;
  files: number;
  manifest: PackManifest;
}> {
  const outFile = path.resolve(outInput);
  const zip = new JSZip();
  const files: PackManifest["files"] = [];

  const addFile = async (relative: string): Promise<void> => {
    const fullPath = path.join(loaded.dir, relative);
    if (!existsSync(fullPath)) {
      return;
    }

    const content = await readFile(fullPath);
    files.push({
      path: relative,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    zip.file(relative, content);
  };

  await addFile("team.yaml");

  for (const dirName of CONTENT_DIRS) {
    const dirPath = path.join(loaded.dir, dirName);
    if (!existsSync(dirPath)) {
      continue;
    }
    for (const relative of await listFiles(loaded.dir, dirPath)) {
      await addFile(relative);
    }
  }

  await addFile("README.md");

  const manifest: PackManifest = {
    name: loaded.pack.metadata.name,
    version: loaded.pack.metadata.version,
    apiVersion: loaded.pack.apiVersion,
    kitCompatibility: loaded.pack.metadata.compatibility.kit,
    exportedAt: new Date().toISOString(),
    files,
  };

  zip.file("pack.manifest.json", JSON.stringify(manifest, null, 2));

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, buffer);

  return { outFile, files: files.length, manifest };
}

async function listFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFiles(root, fullPath)));
    } else if (entry.isFile()) {
      results.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }

  return results;
}
