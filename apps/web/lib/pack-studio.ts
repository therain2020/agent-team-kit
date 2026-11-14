import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPack, readPackFile, splitFrontmatter } from "@kit/pack";
import { parse } from "yaml";
import { getPacksRoot } from "./paths";

export interface StudioAgent {
  id: string;
  isManager: boolean;
  description: string;
  model: string;
  role: "builder" | "seller" | "manager" | "specialist";
  tools: string[];
  skills: string[];
  permissions?: { filesystem?: string; network?: string };
  instructions: string;
  file: string;
}

export interface StudioStage {
  id: string;
  type: "workflow" | "agent" | "coder";
  agent?: string;
  coder?: string;
  gate?: string;
  inputFrom?: string;
  inputsFrom?: string[];
  position?: { x: number; y: number };
  approval?: {
    mode: "required" | "auto" | "never";
    position: "before" | "after";
    riskClass: "low" | "medium" | "high";
    ttl: string;
    autoApproveWhen?: {
      maxRunCostCny?: number;
      riskClass?: Array<"low" | "medium" | "high">;
      stages?: string[];
    };
  };
}

export interface StudioWorkflow {
  file: string;
  id: string;
  raw: string;
  stages: StudioStage[];
}

export interface StudioData {
  dirName: string;
  packName: string;
  description: string;
  agents: StudioAgent[];
  workflows: StudioWorkflow[];
  policies: Array<{ file: string; raw: string }>;
  autopilotRaw: string;
  autopilotPath: string;
  roleRules: {
    requireSeller: boolean;
    requireBuilder: boolean;
    allowCombined: boolean;
  };
  warnings: string[];
}

export async function loadStudioData(
  dirName: string,
): Promise<StudioData | null> {
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

  const agents: StudioAgent[] = [];
  const managerId = "manager";
  const managerFile = loaded.pack.manager?.agent;
  if (managerFile && existsSync(path.join(loaded.dir, managerFile))) {
    const raw = await readFile(path.join(loaded.dir, managerFile), "utf8");
    const frontmatter = splitFrontmatter(raw);
    agents.push({
      id: managerId,
      isManager: true,
      description: asString(frontmatter.data.description, "Team manager"),
      model: asString(
        frontmatter.data.model,
        loaded.pack.manager?.model ?? "deepseek-pro",
      ),
      role: "manager",
      tools: asStringArray(frontmatter.data.tools),
      skills: asStringArray(frontmatter.data.skills),
      permissions: asPermissions(frontmatter.data.permissions),
      instructions: frontmatter.body,
      file: managerFile,
    });
  }

  for (const [id, entry] of loaded.agents) {
    if (entry.spec.file === managerFile) {
      continue;
    }
    const raw = await readFile(path.join(loaded.dir, entry.spec.file), "utf8");
    const frontmatter = splitFrontmatter(raw);
    agents.push({
      id,
      isManager: false,
      description: asString(
        frontmatter.data.description,
        entry.frontmatter.description,
      ),
      model: asString(frontmatter.data.model, entry.frontmatter.model),
      role: entry.role,
      tools: asStringArray(frontmatter.data.tools),
      skills: asStringArray(frontmatter.data.skills),
      permissions: asPermissions(frontmatter.data.permissions),
      instructions: frontmatter.body,
      file: entry.spec.file,
    });
  }

  const workflows: StudioWorkflow[] = [];
  for (const file of loaded.pack.workflows) {
    const raw = await readFile(path.join(loaded.dir, file), "utf8");
    const doc = parse(raw) as {
      id?: unknown;
      stages?: unknown;
    };
    const stages = Array.isArray(doc.stages)
      ? doc.stages.flatMap((stage) => {
          if (typeof stage !== "object" || stage === null) {
            return [];
          }
          const value = stage as Record<string, unknown>;
          if (typeof value.id !== "string") {
            return [];
          }
          const approval =
            typeof value.approval === "object" && value.approval !== null
              ? (value.approval as {
                  mode?: "required" | "auto" | "never";
                  position?: "before" | "after";
                  riskClass?: "low" | "medium" | "high";
                  ttl?: string;
                  autoApproveWhen?: {
                    maxRunCostCny?: number;
                    riskClass?: Array<"low" | "medium" | "high">;
                    stages?: string[];
                  };
                })
              : undefined;
          const position =
            typeof value.position === "object" && value.position !== null
              ? (value.position as { x?: unknown; y?: unknown })
              : undefined;
          return [
            {
              id: value.id,
              type:
                value.type === "workflow"
                  ? "workflow"
                  : value.type === "coder"
                    ? "coder"
                    : "agent",
              agent: typeof value.agent === "string" ? value.agent : undefined,
              coder: typeof value.coder === "string" ? value.coder : undefined,
              gate: typeof value.gate === "string" ? value.gate : undefined,
              inputFrom:
                typeof value.inputFrom === "string"
                  ? value.inputFrom
                  : undefined,
              inputsFrom: Array.isArray(value.inputsFrom)
                ? value.inputsFrom.filter(
                    (item): item is string => typeof item === "string",
                  )
                : undefined,
              ...(position &&
              typeof position.x === "number" &&
              typeof position.y === "number"
                ? { position: { x: position.x, y: position.y } }
                : {}),
              ...(approval
                ? {
                    approval: {
                      mode: approval.mode ?? "required",
                      position: approval.position ?? "after",
                      riskClass: approval.riskClass ?? "medium",
                      ttl: approval.ttl ?? "72h",
                      autoApproveWhen: approval.autoApproveWhen,
                    },
                  }
                : {}),
            } satisfies StudioStage,
          ];
        })
      : [];
    workflows.push({
      file,
      id: typeof doc.id === "string" ? doc.id : file,
      raw,
      stages,
    });
  }

  const policies = await Promise.all(
    loaded.pack.policies.map(async (file) => ({
      file,
      raw: await readPackFile(loaded.dir, file),
    })),
  );

  const autopilotPath = "autopilot.yaml";
  const autopilotRaw = existsSync(path.join(loaded.dir, autopilotPath))
    ? await readFile(path.join(loaded.dir, autopilotPath), "utf8")
    : "";

  return {
    dirName,
    packName: loaded.pack.metadata.name,
    description: loaded.pack.metadata.description ?? "",
    agents,
    workflows,
    policies,
    autopilotRaw,
    autopilotPath,
    roleRules: loaded.roleRules,
    warnings: loaded.warnings,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asPermissions(
  value: unknown,
): { filesystem?: string; network?: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { filesystem?: unknown; network?: unknown };
  return {
    filesystem:
      typeof record.filesystem === "string" ? record.filesystem : undefined,
    network: typeof record.network === "string" ? record.network : undefined,
  };
}
