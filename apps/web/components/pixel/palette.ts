/** Shared 8-bit palette for the pixel primitives (97 §3.1). */

export interface AgentPalette {
  hair: string;
  shirt: string;
  pants: string;
  skin: string;
}

export const AGENT_PALETTES: AgentPalette[] = [
  { hair: "#2f221c", shirt: "#4f7cff", pants: "#23304d", skin: "#f0c49f" },
  { hair: "#6b3f25", shirt: "#e8a33d", pants: "#3a2f2a", skin: "#e7b48d" },
  { hair: "#1e1e24", shirt: "#45b39d", pants: "#223b36", skin: "#f2c9a8" },
  { hair: "#7a4b2a", shirt: "#c96bce", pants: "#332744", skin: "#dfa77f" },
  { hair: "#2a2a33", shirt: "#d96c6c", pants: "#41252b", skin: "#f5d0b0" },
  { hair: "#4a2f24", shirt: "#63b3ed", pants: "#25384d", skin: "#e8b58c" },
];

export const MANAGER_PALETTE: AgentPalette = {
  hair: "#2b2b33",
  shirt: "#d4b45c",
  pants: "#1f2937",
  skin: "#f0c49f",
};

export const PIXEL_INK = "#0e1420";
export const PIXEL_STEEL = "#3f3f46";
export const PIXEL_AMBER = "#fbbf24";
export const PIXEL_RED = "#f87171";
export const PIXEL_GREEN = "#34d399";

const FALLBACK_PALETTE: AgentPalette = {
  hair: "#2f221c",
  shirt: "#4f7cff",
  pants: "#23304d",
  skin: "#f0c49f",
};

export function agentPalette(seed: number): AgentPalette {
  const index = Math.abs(Math.trunc(seed)) % AGENT_PALETTES.length;
  return AGENT_PALETTES[index] ?? FALLBACK_PALETTE;
}

/**
 * Stable sprite seed for an agent id. The office station and a factory
 * workpiece resolve the same producer to the same sprite, so the same person
 * never appears twice with different colors (97 §3.5).
 */
export function agentSeed(agentId: string): number {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return hash;
}
