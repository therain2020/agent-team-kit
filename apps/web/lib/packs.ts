import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type LoadedPack,
  type SimulationReport,
  loadPack,
  simulatePack,
} from "@kit/pack";
import { getPacksRoot } from "./paths";

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
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, "team.yaml"))) {
      continue;
    }

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
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name));
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
