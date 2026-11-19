"use client";

import { quickJumpHref } from "@/lib/nav";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** How long after pressing `g` the next key still counts as a chord. */
const CHORD_WINDOW_MS = 1200;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

/**
 * `g`-prefixed quick jumps (issue #160): press `g` then the entry's letter,
 * e.g. `g o` → Office, `g w` → World. Mirrors the hints shown in the command
 * palette. Ignored while typing in a field or with a modifier held.
 */
export function QuickJump() {
  const router = useRouter();
  const pathname = usePathname();
  const armedAt = useRef<number | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditable(event.target)) {
        armedAt.current = null;
        return;
      }

      const key = event.key.toLowerCase();

      if (armedAt.current === null) {
        if (key === "g") {
          armedAt.current = Date.now();
        }
        return;
      }

      const armed = Date.now() - armedAt.current;
      armedAt.current = null;
      if (armed > CHORD_WINDOW_MS) {
        return;
      }

      const href = quickJumpHref(key);
      if (href && href !== pathname) {
        event.preventDefault();
        router.push(href);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname, router]);

  return null;
}
