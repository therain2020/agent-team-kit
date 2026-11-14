import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FAVICON_SVG,
  type PublishedRun,
  SITE_CSS,
  type SiteIndex,
  type SiteOptions,
  mergeSiteIndex,
  renderNotFound,
  renderSiteIndex,
} from "@kit/publish";

export interface AssembleSiteInput {
  run: PublishedRun;
  runFiles: Record<string, string>;
  options: SiteOptions;
  explicitTitle: boolean;
  explicitDescription: boolean;
}

export async function assembleSite(
  dir: string,
  input: AssembleSiteInput,
): Promise<SiteIndex> {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });

  const existing = await readSiteIndex(root);
  const options: SiteOptions = {
    ...input.options,
    title:
      !input.explicitTitle && existing ? existing.title : input.options.title,
    description:
      !input.explicitDescription && existing
        ? existing.description
        : input.options.description,
  };

  if (!existing) {
    await removeLegacyRunFiles(root);
  }

  await rm(path.join(root, "runs", safeSegment(input.run.runId)), {
    recursive: true,
    force: true,
  });

  for (const [relative, content] of Object.entries(input.runFiles)) {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`unsafe publish path: ${relative}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "site.css"), SITE_CSS, "utf8");
  await writeFile(
    path.join(root, "assets", "favicon.svg"),
    FAVICON_SVG,
    "utf8",
  );
  await writeFile(path.join(root, ".nojekyll"), "", "utf8");

  const site = mergeSiteIndex(existing, input.run, options);
  await writeFile(
    path.join(root, "site.json"),
    `${JSON.stringify(site, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "index.html"),
    renderSiteIndex(site, options),
    "utf8",
  );
  await writeFile(path.join(root, "404.html"), renderNotFound(options), "utf8");

  return site;
}

async function readSiteIndex(root: string): Promise<SiteIndex | null> {
  try {
    const raw = await readFile(path.join(root, "site.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<SiteIndex>;
    if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
      return null;
    }
    return {
      version: 1,
      title: typeof parsed.title === "string" ? parsed.title : "Published runs",
      description:
        typeof parsed.description === "string" ? parsed.description : "",
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      runs: parsed.runs,
    };
  } catch {
    return null;
  }
}

async function removeLegacyRunFiles(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^art_.*\.html$/.test(entry.name)) {
      await rm(path.join(root, entry.name), { force: true });
    }
  }
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "item";
}
