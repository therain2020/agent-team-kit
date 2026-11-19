"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";

/**
 * Right-side drawer used by the world surface. The URL owns open/closed state
 * (`?run=…`), so Escape and the backdrop both navigate back to `closeHref`
 * instead of mutating local state; deep links and history stay correct.
 */
export function DrawerShell({
  closeHref,
  label,
  closeLabel,
  size = "md",
  children,
}: {
  closeHref: string;
  label: string;
  closeLabel: string;
  /** `md` is the run/activity drawer; `full` is the dense Atlas overlay. */
  size?: "md" | "full";
  children: ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        router.push(closeHref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeHref, router]);

  return (
    <dialog
      open
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-inherit"
    >
      <Link
        href={closeHref}
        aria-label={closeLabel}
        className="absolute inset-0 bg-black/60 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      />
      <section
        className={
          size === "full"
            ? "absolute inset-0 flex w-full flex-col overflow-hidden border-l border-border bg-background shadow-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
            : "absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col overflow-hidden border-l border-border bg-background shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200"
        }
      >
        {children}
      </section>
    </dialog>
  );
}
