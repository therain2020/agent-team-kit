"use client";

import { shouldPlayRoomWipe } from "@/lib/pixel-events";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { PixelRoom } from "./pixel-room";
import { usePixelMotion } from "./use-pixel-motion";

/** How long the pixel wipe plays before the route changes (97 §3.5). */
export const ROOM_SWITCH_MS = 160;

export interface WorldHudItem {
  key: string;
  label: string;
  value: ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}

const HUD_TONE: Record<NonNullable<WorldHudItem["tone"]>, string> = {
  default: "text-px-muted",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
};

/**
 * Shared HUD strip: pending approvals, shift decisions and cost are rendered
 * by the same component on both rooms so the two never format them differently
 * (97 §3.5).
 */
export function WorldHud({
  items,
  className,
}: {
  items: readonly WorldHudItem[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "flex flex-wrap items-center gap-1.5 font-mono text-[9px]",
        className,
      )}
    >
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-1 border border-px-line bg-px-ink px-1.5 py-0.5"
        >
          <dt className="uppercase tracking-wide text-px-faint">
            {item.label}
          </dt>
          <dd className={HUD_TONE[item.tone ?? "default"]}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Door plate between the two rooms. With motion enabled the click plays one
 * short pixel wipe, then navigates; `prefers-reduced-motion` (or the stored
 * preference) falls through to a plain link so navigation is instantaneous.
 */
export function PixelDoor({
  href,
  label,
  count,
  icon,
  shortcut,
  title,
  className,
}: {
  href: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  /** Single-key room switch advertised via `aria-keyshortcuts`. */
  shortcut?: string;
  /** Door plate tooltip, e.g. the first pending workpieces. */
  title?: string;
  className?: string;
}) {
  const { enabled } = usePixelMotion();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!shouldPlayRoomWipe(event, { motionEnabled: enabled, leaving })) {
      return;
    }
    event.preventDefault();
    setLeaving(true);
    timer.current = setTimeout(() => router.push(href), ROOM_SWITCH_MS);
  }

  return (
    <>
      <Link
        href={href}
        onClick={handleClick}
        aria-keyshortcuts={shortcut}
        title={title}
        className={cn(
          "group flex items-center gap-1.5 border-2 border-px-line2 bg-px-panel3 px-2 py-1 font-mono text-[10px] text-px-muted outline-none transition-colors hover:border-px-cream hover:text-px-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-px-cream",
          className,
        )}
      >
        {icon}
        <span className="uppercase tracking-wide">{label}</span>
        {typeof count === "number" ? (
          <span
            className={cn(
              "ml-0.5 min-w-4 border px-1 text-center text-[9px]",
              count > 0
                ? "border-amber-500/50 bg-amber-500/10 text-amber-200"
                : "border-px-line text-px-faint",
            )}
          >
            {count}
          </span>
        ) : null}
        {shortcut ? (
          <kbd className="border border-px-line bg-px-ink px-1 text-[9px] leading-4 text-px-faint">
            {shortcut}
          </kbd>
        ) : null}
      </Link>
      {leaving ? (
        <span
          aria-hidden="true"
          className="room-wipe pointer-events-none fixed inset-0 z-50 bg-px-bg"
        />
      ) : null}
    </>
  );
}

/**
 * Room shell shared by the office and the factory (97 §3.5): one title bar,
 * HUD slot and door plates around the floor grid. Both routes stay separate;
 * only the chrome is shared.
 */
export function PixelWorld({
  title,
  subtitle,
  badge = "KIT",
  hud,
  doors,
  children,
  className,
  innerClassName,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  hud?: ReactNode;
  /** Door plates rendered on the right of the title bar. */
  doors?: ReactNode;
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <PixelRoom className={className} innerClassName={innerClassName}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 items-center justify-center border border-px-line2 bg-px-panel3 font-mono text-[10px] text-px-accent">
            {badge}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-px-text">
              {title}
            </p>
            {subtitle ? (
              <p className="truncate font-mono text-[9px] text-px-faint">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {hud}
          {doors}
        </div>
      </div>
      {children}
    </PixelRoom>
  );
}
