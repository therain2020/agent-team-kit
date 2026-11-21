import {
  type CycleOptions,
  type EvolutionCycleRecord,
  type EvolutionRepository,
  type HiddenEvalsResolution,
  resolveHiddenEvalsDir,
  runEvolutionCycle,
} from "@kit/evolution";
import { getEvolutionRepo } from "./evolution-repo";

/** A web cycle never supplies its own repo or hidden-set fields. */
export type WebEvolutionCycleInput = Omit<
  CycleOptions,
  "repo" | "hiddenEvals" | "requireHiddenEvals" | "workspaceId"
>;

export interface WebEvolutionCycleDeps {
  repo?: EvolutionRepository;
  /** Override for tests; defaults to the shared home/workspace resolver. */
  resolveHidden?: (workspaceId: string) => HiddenEvalsResolution;
  runCycle?: typeof runEvolutionCycle;
}

/**
 * Web-triggered cycles always demand a hidden eval set (70 §5). The cycle and
 * the CLI resolve the same directory through `resolveHiddenEvalsDir`; when the
 * directory or its `suite.yaml` is missing the cycle skips with the reason
 * recorded instead of silently scoring against the visible rubric only.
 */
export async function runWebEvolutionCycle(
  options: WebEvolutionCycleInput,
  deps: WebEvolutionCycleDeps = {},
): Promise<EvolutionCycleRecord> {
  const repo = deps.repo ?? (await getEvolutionRepo());
  const workspaceId = repo.workspaceId;
  const resolveHidden =
    deps.resolveHidden ??
    ((id: string) => resolveHiddenEvalsDir({ workspaceId: id }));
  const hidden = resolveHidden(workspaceId);
  const runCycle = deps.runCycle ?? runEvolutionCycle;

  return await runCycle({
    ...options,
    repo,
    workspaceId,
    hiddenEvals: hidden,
    requireHiddenEvals: true,
    ...(hidden.status === "available" ? { hiddenEvalsDir: hidden.dir } : {}),
  });
}
