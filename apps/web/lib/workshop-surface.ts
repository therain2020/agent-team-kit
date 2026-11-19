import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { splitFrontmatter } from "@kit/pack";
import { BUILTIN_SOURCES } from "@kit/source";
import { type PackSummary, listPacks, loadPackDetail } from "./packs";
import { loadInstalledSources } from "./sources";
import type {
  WorkshopPackView,
  WorkshopRoleView,
  WorkshopSourceView,
  WorkshopSurfaceData,
  WorkshopWorkflowView,
} from "./workshop-link";
import { matchSourceNames } from "./workshop-link";

/**
 * Server read model for the /workshop surface (issue #164, plan 88 §1, 82 §3).
 *
 * Packs, sources and the assembly view are loaded once and shipped to the
 * client as plain data so selecting a pack can relink the three columns
 * without a full page navigation. The pack -> source link is derived from
 * source names referenced by the pack's own files until 88 M3b lockfiles
 * declare explicit component bindings; when a pack references no source the
 * surface falls back to every available source (83 §3.1 "builtin + installed").
 */

const MAX_TEXT_FILES = 120;
const MAX_TEXT_BYTES = 512 * 1024;
const TEXT_FILE = /\.(md|ya?ml|json|txt)$/i;

export async function loadWorkshopSurface(): Promise<WorkshopSurfaceData> {
  const [summaries, installed] = await Promise.all([
    listPacks(),
    loadInstalledSources(),
  ]);
  const sources: WorkshopSourceView[] = [
    ...installed.map((source) => ({
      name: source.definition.metadata.name,
      version: source.definition.metadata.version,
      description: source.definition.metadata.description ?? "",
      homepage: source.definition.metadata.homepage,
      license: source.definition.metadata.license,
      repo: source.meta.repo,
      commit: source.meta.commit,
      trust: source.meta.trust,
      builtin: false,
    })),
    ...BUILTIN_SOURCES.map((name) => ({
      name,
      version: "builtin",
      description: "",
      repo: "agent-team-kit",
      commit: "",
      trust: "builtin",
      builtin: true,
    })),
  ];
  const sourceNames = sources.map((source) => source.name);
  const packs = await Promise.all(
    summaries.map((summary) => toPackView(summary, sourceNames)),
  );
  return { packs, sources };
}

async function toPackView(
  summary: PackSummary,
  sourceNames: string[],
): Promise<WorkshopPackView> {
  const base = {
    dirName: summary.dirName,
    name: summary.name,
    version: summary.version,
    description: "",
    errors: summary.errors ?? [],
    warnings: summary.warnings,
    agentCount: summary.agentCount,
    skillCount: summary.skillCount,
    workflowCount: summary.workflowCount,
    policyCount: summary.policyCount,
    workflows: [] as WorkshopWorkflowView[],
    roles: [] as WorkshopRoleView[],
    skills: [] as string[],
    usedSources: [] as string[],
  };

  if (summary.errors?.length) {
    return { ...base, valid: false };
  }

  const detail = await loadPackDetail(summary.dirName);
  if (!detail) {
    return {
      ...base,
      valid: false,
      errors: ["pack failed to load"],
    };
  }

  const { loaded, simulation } = detail;
  const roles: WorkshopRoleView[] = [];
  const managerFile = loaded.pack.manager?.agent;
  if (managerFile) {
    roles.push({
      id: "manager",
      role: "manager",
      model: loaded.pack.manager?.model ?? "deepseek-pro",
      isManager: true,
      description: await readDescription(loaded.dir, managerFile),
      skills: [],
    });
  }
  for (const [id, entry] of loaded.agents) {
    roles.push({
      id,
      role: entry.role,
      model: entry.spec.model,
      isManager: false,
      description: entry.frontmatter.description,
      skills: entry.spec.skills,
    });
  }

  const workflows: WorkshopWorkflowView[] = simulation.workflows.map(
    (workflow) => ({
      id: workflow.id,
      stages: workflow.stages.length,
      costCny: workflow.totalCostCny,
      stageViews: workflow.stages.map((stage) => ({
        id: stage.id,
        type: stage.type,
        agent: stage.agent,
        coder: stage.coder,
        gate: stage.gate,
        costCny: stage.estimatedCostCny,
      })),
    }),
  );

  const text = await readPackTexts(loaded.dir);
  return {
    ...base,
    description: loaded.pack.metadata.description ?? "",
    valid: true,
    errors: [],
    warnings: loaded.warnings,
    workflows,
    roles,
    skills: [...loaded.skills.keys()],
    usedSources: matchSourceNames(text, sourceNames),
  };
}

async function readDescription(dir: string, file: string): Promise<string> {
  try {
    const raw = await readFile(path.join(dir, file), "utf8");
    const data = splitFrontmatter(raw).data;
    return typeof data.description === "string" ? data.description : "";
  } catch {
    return "";
  }
}

/**
 * Concatenate the pack's text files so source references can be detected.
 * Bounded by file count and total bytes; only text formats are read.
 */
export async function readPackTexts(dir: string): Promise<string> {
  const parts: string[] = [];
  let files = 0;
  let bytes = 0;

  async function walk(current: string): Promise<void> {
    if (files >= MAX_TEXT_FILES || bytes >= MAX_TEXT_BYTES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_TEXT_FILES || bytes >= MAX_TEXT_BYTES) {
        return;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_FILE.test(entry.name)) {
        continue;
      }
      try {
        const raw = await readFile(full, "utf8");
        parts.push(raw);
        files += 1;
        bytes += Buffer.byteLength(raw, "utf8");
      } catch {
        // Unreadable files simply do not contribute references.
      }
    }
  }

  await walk(dir);
  return parts.join("\n");
}
