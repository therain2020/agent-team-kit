import type { AgentRole } from "@kit/core";

/**
 * Client-safe types and linking logic for the /workshop surface.
 *
 * Kept free of Node and @kit/pack imports so the three-column surface can
 * relink packs, sources and assembly in the browser. Server data loading lives
 * in ./workshop-surface.ts.
 */

export interface WorkshopStageView {
  id: string;
  type: string;
  agent?: string;
  coder?: string;
  gate?: string;
  costCny: number;
}

export interface WorkshopWorkflowView {
  id: string;
  stages: number;
  costCny: number;
  stageViews: WorkshopStageView[];
}

export interface WorkshopRoleView {
  id: string;
  role: AgentRole;
  model: string;
  isManager: boolean;
  description: string;
  skills: string[];
}

export interface WorkshopPackOriginView {
  repo: string;
  commit: string;
  manifestSha256: string;
  installedAt: string;
  trust: "builtin" | "verified" | "community";
}

export interface WorkshopPackView {
  dirName: string;
  name: string;
  version: string;
  description: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  agentCount: number;
  skillCount: number;
  workflowCount: number;
  policyCount: number;
  workflows: WorkshopWorkflowView[];
  roles: WorkshopRoleView[];
  skills: string[];
  usedSources: string[];
  /** Set when the pack was installed from the workshop into packs/. */
  workshop?: WorkshopPackOriginView;
}

export interface WorkshopSourceView {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  license?: string;
  repo: string;
  commit: string;
  trust: string;
  builtin: boolean;
}

export interface WorkshopSurfaceData {
  packs: WorkshopPackView[];
  sources: WorkshopSourceView[];
}

export type WorkshopTab = "packs" | "sources" | "assembly";

/**
 * Case-insensitive, boundary-aware match of known source names in pack text.
 * Names shorter than two characters are ignored to avoid noise.
 */
export function matchSourceNames(text: string, names: string[]): string[] {
  const hits = new Set<string>();
  for (const raw of names) {
    const name = raw.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,}$/.test(name)) {
      continue;
    }
    const pattern = new RegExp(
      `(^|[^a-z0-9-])${escapeRegExp(name)}([^a-z0-9-]|$)`,
      "i",
    );
    if (pattern.test(text)) {
      hits.add(name);
    }
  }
  return [...hits].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Linked view used by the three-column surface: selecting a pack scopes the
 * source column to that pack's referenced sources. Packs without references
 * (and the "all" scope) show every available source.
 */
export function linkedSourceView(
  pack: WorkshopPackView | null,
  sources: WorkshopSourceView[],
  scope: "pack" | "all" = "pack",
): { visible: WorkshopSourceView[]; scoped: boolean } {
  const used = new Set(pack?.usedSources ?? []);
  if (!pack || scope === "all" || used.size === 0) {
    return { visible: sources, scoped: false };
  }
  const visible = sources.filter((source) => used.has(source.name));
  return visible.length > 0
    ? { visible, scoped: true }
    : { visible: sources, scoped: false };
}

export function parseWorkshopTab(value: string | undefined): WorkshopTab {
  return value === "sources" || value === "assembly" ? value : "packs";
}

export function pickSelectedPack(
  packs: WorkshopPackView[],
  dirName: string | undefined,
): WorkshopPackView | null {
  if (packs.length === 0) {
    return null;
  }
  return (
    packs.find((pack) => pack.dirName === dirName) ??
    packs.find((pack) => pack.valid) ??
    packs[0] ??
    null
  );
}
