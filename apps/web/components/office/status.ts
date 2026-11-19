import type { LiveAgent } from "@/lib/office-live";

/** Status labels shared by the floor, the roster panel and the list fallback. */
export const STATUS_I18N = {
  idle: "statusIdle",
  working: "statusWorking",
  blocked: "statusBlocked",
  waiting: "statusWaiting",
  error: "statusError",
} as const;

/** Status dots shared by every office surface. */
export const STATUS_DOT: Record<LiveAgent["status"], string> = {
  working: "bg-emerald-400",
  waiting: "bg-amber-300",
  blocked: "bg-orange-400",
  error: "bg-red-400",
  idle: "bg-zinc-500",
};
