import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createModelGateway, loadModelConfig } from "@kit/model";
import { loadPack } from "@kit/pack";
import { type ProjectTarget, resolveProject } from "./projects";
import { JobError } from "./types";

export interface DraftJobInput {
  goal: string;
  projectId?: string;
  packDir?: string;
  repoRoot: string;
  env?: Record<string, string | undefined>;
}

export type DraftApplyMode = "none" | "low" | "low-medium";

export interface JobDraft {
  kind: "iteration";
  projectId: string;
  packDir: string;
  domain: string;
  maxTasks: number;
  acceptance: string;
  applyMode: DraftApplyMode;
  runMode: "DRY_RUN";
}

export interface DraftJobResult {
  draft: JobDraft;
  rationale: string;
  warnings: string[];
  project: ProjectTarget;
  model: "live" | "heuristic";
}

const DEFAULT_ACCEPTANCE =
  "Small verified changes; high-risk changes stay pending approval.";

export async function draftJob(input: DraftJobInput): Promise<DraftJobResult> {
  const goal = input.goal.trim();
  if (!goal) {
    throw new JobError("goal_required", "a goal is required", 400);
  }
  const env = input.env ?? process.env;
  const project = await resolveProject(input.repoRoot, input.projectId, env);
  const packId = input.packDir?.trim() || "self-improve";
  const packDir = resolvePackDir(input.repoRoot, packId);
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new JobError(
      "invalid_pack",
      `invalid pack: ${loaded.errors.join("; ")}`,
    );
  }
  if (!loaded.iteration) {
    throw new JobError(
      "iteration_pack_required",
      `pack has no iteration.yaml: ${packDir}`,
      404,
    );
  }
  const domains = Object.keys(loaded.iteration.domains);
  if (domains.length === 0) {
    throw new JobError("invalid_pack", "pack declares no iteration domains");
  }

  const heuristic = heuristicDraft(
    goal,
    domains,
    loaded.iteration.planner.maxTasks,
  );
  const warnings: string[] = [`目标项目：${project.name}（${project.path}）。`];
  if (project.checks.length === 0) {
    warnings.push(
      "目标项目没有可用的验证脚本（typecheck/lint/test）；Verifier 可能判定任务失败。",
    );
  } else {
    warnings.push(`可用验证：${project.checks.join("、")}。`);
  }
  if (project.source === "workspace") {
    warnings.push("apply 要求目标项目工作区干净；有未提交改动时会被阻断。");
  }
  if (env.KIT_UI_ALLOW_LIVE !== "1") {
    warnings.push(
      "LIVE 未开启：只能以 DRY_RUN 运行（可用 kit autonomy enable 或 KIT_UI_ALLOW_LIVE=1 开启）。",
    );
  }

  let draft: JobDraft = {
    kind: "iteration",
    projectId: project.id,
    packDir: packId,
    domain: heuristic.domain,
    maxTasks: heuristic.maxTasks,
    acceptance: DEFAULT_ACCEPTANCE,
    applyMode: "low",
    runMode: "DRY_RUN",
  };
  let rationale = heuristic.rationale;
  let model: DraftJobResult["model"] = "heuristic";

  try {
    const facts = await projectFacts(project);
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You configure an autonomous coding job for a private agent team.
Choose a proposal from the allowed domains. Prefer the smallest scope that satisfies the goal.
Return JSON only:
{"domain":"<one of: ${domains.join(" | ")}>","maxTasks":<1-4>,"applyMode":"none|low|low-medium","acceptance":"<one sentence>","rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- security work -> cyber; UI/usability -> ux; performance -> perf; documentation -> docs when available.
- docs tasks: maxTasks 1.
- never propose applyMode for high-risk changes; high risk stays pending.
- do not invent project facts. If unsure, keep defaults.`,
      input: JSON.stringify({ goal, project: facts, domains }),
    });
    const parsed = parseDraft(response.text);
    if (parsed) {
      const validated = validateDraft(
        parsed,
        domains,
        loaded.iteration.planner.maxTasks,
      );
      draft = {
        ...draft,
        domain: validated.domain,
        maxTasks: validated.maxTasks,
        applyMode: validated.applyMode,
        acceptance: validated.acceptance ?? draft.acceptance,
      };
      rationale = validated.rationale ?? rationale;
      warnings.push(...validated.warnings);
      model = "live";
    }
  } catch {
    warnings.push("AI 草案不可用，已使用启发式配置。");
  }

  return {
    draft,
    rationale,
    warnings: [...new Set(warnings)],
    project,
    model,
  };
}

function heuristicDraft(
  goal: string,
  domains: string[],
  plannerMaxTasks: number,
): { domain: string; maxTasks: number; rationale: string } {
  const text = goal.toLowerCase();
  const has = (name: string) => domains.includes(name);
  let domain = domains[0] ?? "cyber";
  let reason = "没有匹配到特定领域，使用默认域";
  if (
    has("cyber") &&
    /(security|vulnerab|漏洞|安全|attack|auth|xss|injection|secret)/.test(text)
  ) {
    domain = "cyber";
    reason = "目标涉及安全/漏洞";
  } else if (
    has("ux") &&
    /(ux|ui|usability|interface|界面|交互|体验|accessib)/.test(text)
  ) {
    domain = "ux";
    reason = "目标涉及界面/交互";
  } else if (
    has("perf") &&
    /(perf|performance|latency|slow|性能|慢|优化|benchmark)/.test(text)
  ) {
    domain = "perf";
    reason = "目标涉及性能";
  } else if (
    has("docs") &&
    /(docs?|readme|documentation|文档|说明)/.test(text)
  ) {
    domain = "docs";
    reason = "目标涉及文档";
  }
  const maxTasks =
    domain === "docs" ? 1 : Math.min(2, Math.max(1, plannerMaxTasks));
  return {
    domain,
    maxTasks,
    rationale: `${reason}，选择 ${domain} 域、${maxTasks} 个任务，先以 DRY_RUN 验证。`,
  };
}

function parseDraft(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validateDraft(
  parsed: Record<string, unknown>,
  domains: string[],
  plannerMaxTasks: number,
): {
  domain: string;
  maxTasks: number;
  applyMode: DraftApplyMode;
  acceptance?: string;
  rationale?: string;
  warnings: string[];
} {
  const domain =
    typeof parsed.domain === "string" && domains.includes(parsed.domain)
      ? parsed.domain
      : (domains[0] ?? "cyber");
  const maxTasks = clampInt(
    parsed.maxTasks,
    1,
    Math.max(1, plannerMaxTasks),
    2,
  );
  const applyMode: DraftApplyMode =
    parsed.applyMode === "none" ||
    parsed.applyMode === "low" ||
    parsed.applyMode === "low-medium"
      ? parsed.applyMode
      : "low";
  const acceptance =
    typeof parsed.acceptance === "string" && parsed.acceptance.trim()
      ? parsed.acceptance.trim().slice(0, 2000)
      : undefined;
  const rationale =
    typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim().slice(0, 500)
      : undefined;
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  return { domain, maxTasks, applyMode, acceptance, rationale, warnings };
}

async function projectFacts(
  project: ProjectTarget,
): Promise<Record<string, unknown>> {
  let files: string[] = [];
  try {
    const entries = await readdir(project.path, { withFileTypes: true });
    files = entries
      .filter(
        (entry) =>
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          entry.name !== "dist" &&
          entry.name !== "build",
      )
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .slice(0, 30);
  } catch {
    // unreadable project; facts stay minimal
  }
  let readme = "";
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      readme = (await readFile(path.join(project.path, name), "utf8")).slice(
        0,
        800,
      );
      break;
    } catch {
      // try the next name
    }
  }
  return {
    id: project.id,
    name: project.name,
    checks: project.checks,
    files,
    readme,
  };
}

function resolvePackDir(repoRoot: string, packId: string): string {
  const trimmed = packId.trim();
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : trimmed.replace(/\\/g, "/").startsWith("packs/")
      ? path.resolve(repoRoot, trimmed)
      : path.resolve(repoRoot, "packs", trimmed);
  const packsRoot = path.resolve(repoRoot, "packs");
  const prefix = packsRoot.endsWith(path.sep)
    ? packsRoot
    : `${packsRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new JobError("pack_outside_root", "packDir must be inside packs/");
  }
  return resolved;
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
