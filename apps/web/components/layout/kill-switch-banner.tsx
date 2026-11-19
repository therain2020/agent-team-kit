"use client";

import type { KillSwitch } from "@kit/core";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

interface KillSwitchState {
  active: KillSwitch[];
}

const POLL_MS = 30_000;

export function KillSwitchBanner() {
  const t = useTranslations("killSwitch");
  const [active, setActive] = useState<KillSwitch[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/kill-switch", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as KillSwitchState;
        if (!cancelled) {
          setActive(Array.isArray(data.active) ? data.active : []);
        }
      } catch {
        // The banner is advisory; a failed poll must not break the console.
      }
    }

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (active.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b border-red-700 bg-red-950 px-5 py-2 font-mono text-[11px] text-red-100 shadow-px-inset-b"
    >
      <span className="border border-red-700 bg-red-900 px-1 py-0.5 text-[10px] font-bold tracking-[0.12em] text-red-200 uppercase">
        {t("bannerActive")}
      </span>
      <span className="mx-2 text-red-200/80">
        {active
          .map((item) => `${item.scope}/${item.target || "*"} — ${item.reason}`)
          .join(" · ")}
      </span>
      <Link href="/kill-switch" className="underline underline-offset-2">
        {t("bannerLink")}
      </Link>
    </div>
  );
}
