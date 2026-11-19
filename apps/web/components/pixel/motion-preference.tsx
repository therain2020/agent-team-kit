"use client";

import {
  PIXEL_MOTION_STORAGE_KEY,
  resolveMotionEnabled,
} from "@/lib/pixel-events";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

interface PixelMotionValue {
  /** User preference persisted in localStorage. */
  preference: boolean;
  /** OS-level `prefers-reduced-motion`. */
  reduced: boolean;
  /** Whether stepping/shake/reverse may run right now. */
  enabled: boolean;
  setPreference: (value: boolean) => void;
  toggle: () => void;
}

const PixelMotionContext = createContext<PixelMotionValue>({
  preference: true,
  reduced: false,
  enabled: true,
  setPreference: () => undefined,
  toggle: () => undefined,
});

export function PixelMotionProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(true);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PIXEL_MOTION_STORAGE_KEY);
      setPreferenceState(stored !== "off");
    } catch {
      // Storage unavailable (private mode) — keep the default.
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setPreference = useCallback((value: boolean) => {
    setPreferenceState(value);
    try {
      window.localStorage.setItem(
        PIXEL_MOTION_STORAGE_KEY,
        value ? "on" : "off",
      );
    } catch {
      // Persisting is best-effort; the session still honours the toggle.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(!preference);
  }, [preference, setPreference]);

  const value = useMemo<PixelMotionValue>(
    () => ({
      preference,
      reduced,
      enabled: resolveMotionEnabled(preference, reduced),
      setPreference,
      toggle,
    }),
    [preference, reduced, setPreference, toggle],
  );

  return (
    <PixelMotionContext.Provider value={value}>
      {children}
    </PixelMotionContext.Provider>
  );
}

export function usePixelMotion(): PixelMotionValue {
  return useContext(PixelMotionContext);
}

export function PixelMotionToggle({ className }: { className?: string }) {
  const { preference, reduced, enabled, toggle } = usePixelMotion();
  const t = useTranslations("motion");
  const label = enabled ? t("on") : t("off");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={preference}
      aria-label={t("toggle")}
      title={reduced ? t("reducedHint") : t("toggle")}
      className={cn(
        "flex items-center gap-1.5 border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200",
        preference && !reduced && "text-emerald-300",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5", enabled ? "bg-emerald-400" : "bg-zinc-600")}
      />
      {label}
    </button>
  );
}
