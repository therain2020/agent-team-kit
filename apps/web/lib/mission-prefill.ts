import type { AgentRole } from "@kit/core";

/**
 * Station quick actions prefill the mission dialog (97 §3.3, issue #102).
 *
 * A prefill only seeds the initial selection; every role rule is still
 * validated when the dialog submits, and ids that are not valid options for
 * the current pack are dropped instead of being applied blindly.
 */
export interface MissionPrefill {
  manager?: string;
  sellers?: string[];
  builders?: string[];
  specialists?: string[];
}

/** The role fields a prefill may touch; other dialog fields pass through. */
export interface MissionSelection {
  manager: string;
  sellers: string[];
  builders: string[];
  specialists: string[];
}

export interface MissionPrefillOptions {
  managers: readonly string[];
  sellers: readonly string[];
  builders: readonly string[];
  specialists: readonly string[];
}

/** Maps the focused agent onto the role slot it can fill on a mission. */
export function missionPrefillForAgent(agent: {
  id: string;
  isManager: boolean;
  role: AgentRole;
}): MissionPrefill {
  if (agent.isManager) {
    return { manager: agent.id };
  }
  switch (agent.role) {
    case "seller":
      return { sellers: [agent.id] };
    case "builder":
      return { builders: [agent.id] };
    case "specialist":
      return { specialists: [agent.id] };
    default:
      return {};
  }
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function validIds(
  ids: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): string[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  return unique(ids.filter((id) => allowed.has(id)));
}

/**
 * Merges a prefill into a composed (or re-composed) selection.
 *
 * The manager and seller slots are single-valued, so a valid prefill wins and
 * otherwise the composed value is kept. Builder and specialist slots are
 * multi-valued: the prefill is unioned in so the focused agent is definitely
 * selected without discarding the draft's other suggestions.
 */
export function applyMissionPrefill(
  selection: MissionSelection,
  prefill: MissionPrefill | undefined,
  options: MissionPrefillOptions,
): MissionSelection {
  if (!prefill) {
    return selection;
  }
  const managers = new Set(options.managers);
  const prefillManager =
    prefill.manager && managers.has(prefill.manager)
      ? prefill.manager
      : selection.manager;
  const prefillSeller =
    validIds(prefill.sellers, new Set(options.sellers))[0] ??
    selection.sellers[0] ??
    "";
  return {
    manager: prefillManager,
    sellers: prefillSeller ? [prefillSeller] : [],
    builders: unique([
      ...selection.builders,
      ...validIds(prefill.builders, new Set(options.builders)),
    ]),
    specialists: unique([
      ...selection.specialists,
      ...validIds(prefill.specialists, new Set(options.specialists)),
    ]),
  };
}
