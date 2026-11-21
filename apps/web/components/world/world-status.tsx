"use client";

import { useNow } from "@/lib/use-now";
import { cn, timeAgo } from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import type { WorldConnectionStatus } from "@/lib/world-state";
import { useLocale, useTranslations } from "next-intl";

const STATUS_STYLE: Record<
  WorldConnectionStatus,
  { text: string; dot: string; pulse: boolean }
> = {
  live: {
    text: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    dot: "bg-emerald-400",
    pulse: false,
  },
  reconnecting: {
    text: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    dot: "bg-amber-400",
    pulse: true,
  },
  polling: {
    text: "border-sky-500/30 bg-sky-500/10 text-sky-200",
    dot: "bg-sky-400",
    pulse: true,
  },
  offline: {
    text: "border-red-500/30 bg-red-500/10 text-red-200",
    dot: "bg-red-400",
    pulse: true,
  },
};

/**
 * World connection pill shared by the office and the factory (97 §3.2/§3.5).
 * Degrades to "offline · last updated Xs ago" while keeping the last world on
 * screen; only the status label is announced, the ticking time is not.
 */
export function WorldStatus({
  className,
  hideWhenLive = false,
}: {
  className?: string;
  hideWhenLive?: boolean;
}) {
  const { status, lastUpdatedAt, degraded } = useWorld();
  const t = useTranslations("world");
  const locale = useLocale();
  const now = useNow();

  if (hideWhenLive && status === "live") {
    return null;
  }

  const style = STATUS_STYLE[status];
  const updatedAt =
    status !== "live" && lastUpdatedAt !== null
      ? new Date(lastUpdatedAt).toISOString()
      : null;
  const updated = updatedAt
    ? timeAgo(updatedAt, locale, now ?? lastUpdatedAt ?? Date.now())
    : null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
        style.text,
        className,
      )}
      title={updatedAt ? new Date(updatedAt).toLocaleString(locale) : undefined}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          style.dot,
          style.pulse && "motion-safe:animate-pulse",
        )}
        aria-hidden="true"
      />
      <span aria-live="polite">{t(status)}</span>
      {degraded ? (
        <span
          className="border border-amber-500/40 px-1 text-[9px] uppercase"
          title={t("degradedHint")}
        >
          {t("degraded")}
        </span>
      ) : null}
      {updated ? (
        <span className="text-current/70">
          · {t("lastUpdated", { when: updated })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Text label for how long an agent has been in its current state. Rendered
 * only after mount so SSR markup stays stable; hidden from screen readers
 * because the state label already carries the status.
 */
export function SinceLabel({
  since,
  className,
}: {
  since?: string;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("world");
  const now = useNow();
  if (!since || now === null) {
    return null;
  }
  const started = new Date(since).getTime();
  if (!Number.isFinite(started) || started > now) {
    return null;
  }
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  const duration = formatCompact(seconds, locale);
  return (
    <span
      className={cn("font-mono text-[9px] text-zinc-500", className)}
      aria-hidden="true"
      title={t("stateFor", { duration })}
    >
      {t("stateFor", { duration })}
    </span>
  );
}

function formatCompact(seconds: number, locale: string): string {
  if (seconds < 60) {
    return locale === "zh" ? `${seconds} 秒` : `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return locale === "zh" ? `${minutes} 分` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return locale === "zh" ? `${hours} 小时` : `${hours}h`;
}
