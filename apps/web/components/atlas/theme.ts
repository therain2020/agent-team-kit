import type { AtlasNodeStatus } from "@/lib/atlas";

export interface StatusTheme {
  text: string;
  dot: string;
  line: string;
  wash: string;
  glow: string;
}

/** Signal colours come from the Pixel Foundry tokens (issue #165). */
export const STATUS_THEME: Record<AtlasNodeStatus, StatusTheme> = {
  succeeded: {
    text: "text-[#4dd08a]",
    dot: "bg-[#4dd08a]",
    line: "#4dd08a",
    wash: "rgba(77,208,138,0.12)",
    glow: "rgba(77,208,138,0.35)",
  },
  running: {
    text: "text-[#4f9dff]",
    dot: "bg-[#4f9dff]",
    line: "#4f9dff",
    wash: "rgba(79,157,255,0.14)",
    glow: "rgba(79,157,255,0.45)",
  },
  waiting: {
    text: "text-[#e8a33d]",
    dot: "bg-[#e8a33d]",
    line: "#e8a33d",
    wash: "rgba(232,163,61,0.12)",
    glow: "rgba(232,163,61,0.38)",
  },
  failed: {
    text: "text-[#e0555a]",
    dot: "bg-[#e0555a]",
    line: "#e0555a",
    wash: "rgba(224,85,90,0.12)",
    glow: "rgba(224,85,90,0.42)",
  },
  pending: {
    text: "text-px-muted",
    dot: "bg-px-muted",
    line: "#8492a8",
    wash: "rgba(132,146,168,0.10)",
    glow: "rgba(132,146,168,0.20)",
  },
  skipped: {
    text: "text-px-faint",
    dot: "bg-px-faint",
    line: "#75849b",
    wash: "rgba(117,132,155,0.08)",
    glow: "rgba(117,132,155,0.18)",
  },
};

const AGENT_COLORS = [
  "#5eead4",
  "#93c5fd",
  "#c4b5fd",
  "#fda4af",
  "#fcd34d",
  "#7dd3fc",
  "#a3e635",
  "#f0abfc",
];

export function agentColor(id?: string): string {
  if (!id) {
    return "#75849b";
  }
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return AGENT_COLORS[hash % AGENT_COLORS.length] ?? "#75849b";
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "¥0";
  }
  if (Math.abs(value) < 0.01) {
    return `¥${value.toFixed(4)}`;
  }
  return `¥${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

export function formatSpan(ms?: number): string {
  if (!ms || ms <= 0) {
    return "—";
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function truncateLabel(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function minuteOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}
