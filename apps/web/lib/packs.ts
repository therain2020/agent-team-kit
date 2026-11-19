import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type LoadedPack,
  type SimulationReport,
  loadPack,
  simulatePack,
} from "@kit/pack";
import { getPacksRoot } from "./paths";

/**
 * Provenance recorded in `.workshop.json` when a pack is installed straight
 * from the workshop into `packs/` (plan 88 §3.4).
 */
export interface PackWorkshopOrigin {
  repo: string;
  commit: string;
  manifestSha256: string;
  installedAt: string;
  trust: "builtin" | "verified" | "community";
}

export interface PackSummary {
  dirName: string;
  name: string;
  version: string;
  apiVersion: string;
  agentCount: number;
  skillCount: number;
  workflowCount: number;
  policyCount: number;
  warnings: string[];
  workflows: Array<{ id: string; stages: number; estimatedCostCny: number }>;
  errors?: string[];
  workshop?: PackWorkshopOrigin;
}

export interface PackDetail {
  dirName: string;
  loaded: LoadedPack;
  simulation: SimulationReport;
}

export async function listPacks(): Promise<PackSummary[]> {
  const root = getPacksRoot();
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const summaries: PackSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, "team.yaml"))) {
      continue;
    }
    const workshop = await readWorkshopOrigin(dir);

    const loaded = await loadPack(dir);
    if (!loaded.ok) {
      summaries.push({
        dirName: entry.name,
        name: entry.name,
        version: "invalid",
        apiVersion: "unknown",
        agentCount: 0,
        skillCount: 0,
        workflowCount: 0,
        policyCount: 0,
        warnings: [],
        workflows: [],
        errors: loaded.errors,
        ...(workshop ? { workshop } : {}),
      });
      continue;
    }

    const simulation = simulatePack(loaded);
    summaries.push({
      dirName: entry.name,
      name: loaded.pack.metadata.name,
      version: loaded.pack.metadata.version,
      apiVersion: loaded.pack.apiVersion,
      agentCount: loaded.pack.agents.length,
      skillCount: loaded.skills.size,
      workflowCount: loaded.workflows.length,
      policyCount: loaded.policies.length,
      warnings: loaded.warnings,
      workflows: simulation.workflows.map((workflow) => ({
        id: workflow.id,
        stages: workflow.stages.length,
        estimatedCostCny: workflow.totalCostCny,
      })),
      ...(workshop ? { workshop } : {}),
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

async function readWorkshopOrigin(
  dir: string,
): Promise<PackWorkshopOrigin | null> {
  const recordPath = path.join(dir, ".workshop.json");
  if (!existsSync(recordPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof raw.repo !== "string" || typeof raw.commit !== "string") {
      return null;
    }
    const trust = (raw.trust ?? {}) as Record<string, unknown>;
    return {
      repo: raw.repo,
      commit: raw.commit,
      manifestSha256:
        typeof raw.manifestSha256 === "string" ? raw.manifestSha256 : "",
      installedAt: typeof raw.installedAt === "string" ? raw.installedAt : "",
      trust:
        trust.level === "builtin" || trust.level === "verified"
          ? trust.level
          : "community",
    };
  } catch {
    return null;
  }
}

export async function loadPackDetail(
  dirName: string,
): Promise<PackDetail | null> {
  if (path.basename(dirName) !== dirName || dirName.includes("..")) {
    return null;
  }
  const dir = path.join(getPacksRoot(), dirName);
  if (!existsSync(path.join(dir, "team.yaml"))) {
    return null;
  }
  const loaded = await loadPack(dir);
  if (!loaded.ok) {
    return null;
  }
  return {
    dirName,
    loaded,
    simulation: simulatePack(loaded),
  };
}
