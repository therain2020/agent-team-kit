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
      className="border-b border-red-700/50 bg-red-950/40 px-5 py-2 text-xs text-red-100"
    >
      <span className="font-medium">{t("bannerActive")}</span>
      <span className="mx-2 text-red-300/70">
        {active
          .map((item) => `${item.scope}/${item.target || "*"} — ${item.reason}`)
          .join(" · ")}
      </span>
      <Link href="/kill-switch" className="underline">
        {t("bannerLink")}
      </Link>
    </div>
  );
}
