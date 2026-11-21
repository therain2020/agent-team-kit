/**
 * Cross-room deep links (97 §3.5): the office and the factory only accept the
 * `pack` and `agent` parameters, both optional and both validated against what
 * the server actually loaded. Unknown values show an empty state instead of
 * silently falling back to another pack or station.
 */

export interface OfficeRoomParams {
  pack: string | null;
  agent: string | null;
}

/** Factory surface deep link, shared by door plates and keyboard `F`. */
export const FACTORY_ROOM_HREF = "/approvals?view=factory";

export function officeRoomHref(): string {
  return "/office";
}

/** Office deep link for one producer; the office resolves the pack by agent. */
export function officeAgentHref(agentId: string): string {
  const params = new URLSearchParams({ agent: agentId });
  return `/office?${params.toString()}`;
}

function first(value: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export function parseOfficeRoomParams(params: {
  pack?: string | string[] | null;
  agent?: string | string[] | null;
}): OfficeRoomParams {
  return {
    pack: first(params.pack),
    agent: first(params.agent),
  };
}

export interface OfficeLinkData {
  packs: ReadonlyArray<{ dirName: string }>;
  active: { agents: ReadonlyArray<{ id: string }> } | null;
}

export type OfficeLinkProblem = "pack" | "agent" | null;

/**
 * Why a deep link cannot be honoured, or `null` when it can. Checked after the
 * loader has resolved the pack, so an agent link that selected another pack is
 * still validated against that pack's roster.
 */
export function officeLinkProblem(
  params: OfficeRoomParams,
  data: OfficeLinkData,
): OfficeLinkProblem {
  if (params.pack && !data.packs.some((pack) => pack.dirName === params.pack)) {
    return "pack";
  }
  if (
    params.agent &&
    (!data.active ||
      !data.active.agents.some((agent) => agent.id === params.agent))
  ) {
    return "agent";
  }
  return null;
}

/** Requested station wins only when it exists; otherwise the first station. */
export function resolveInitialAgent(
  agents: ReadonlyArray<{ id: string; isManager?: boolean }>,
  requested: string | null | undefined,
): string {
  const match = requested
    ? agents.find((agent) => agent.id === requested)
    : undefined;
  return match?.id ?? agents[0]?.id ?? "manager";
}
