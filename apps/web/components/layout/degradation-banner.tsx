"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

export interface DegradationBannerMode {
  modeId: string;
  scope: "workspace" | "global";
  workspaceId: string;
  kind: "degraded" | "read_only";
  enteredAt: string;
}

export function DegradationBanner({
  initialModes,
}: {
  initialModes: DegradationBannerMode[];
}) {
  const t = useTranslations("degradation");
  const [modes, setModes] = useState(initialModes);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/degradation", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          modes?: DegradationBannerMode[];
        };
        if (!cancelled) {
          setModes(data.modes ?? []);
        }
      } catch {
        // Polling must never break the console shell.
      }
    };
    const timer = setInterval(() => {
      void load();
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (modes.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-red-700 bg-red-950 px-5 py-2 font-mono text-[11px] text-red-100"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {modes.map((mode) => (
          <span key={mode.modeId} className="flex items-center gap-2">
            <span className="border border-red-700 bg-red-900 px-1 py-0.5 text-[10px] font-bold tracking-[0.12em] text-red-200 uppercase">
              {mode.kind === "read_only"
                ? t("kindReadOnly")
                : t("kindDegraded")}
            </span>
            <span>
              {mode.kind === "read_only"
                ? t("bannerReadOnly")
                : t("bannerDegraded")}
            </span>
            <span className="text-[10px] text-red-200/80">
              {mode.scope === "global"
                ? t("globalLabel")
                : `${t("workspaceLabel")} ${mode.workspaceId}`}{" "}
              · {mode.modeId}
            </span>
          </span>
        ))}
        <Link
          href="/ops?section=degradation"
          className="ml-auto underline underline-offset-2"
        >
          {t("manage")}
        </Link>
      </div>
    </div>
  );
}
