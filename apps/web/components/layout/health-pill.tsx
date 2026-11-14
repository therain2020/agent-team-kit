"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface Health {
  ok: boolean;
  db: string;
  temporal: string;
  worker: string;
  blobBackend: string;
}

const POLL_MS = 30_000;

export function HealthPill() {
  const t = useTranslations("health");
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const data = (await response.json()) as Health;
        if (!cancelled) {
          setHealth(data);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
        }
      }
    }

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const items = [
    { key: "db", label: t("db"), state: health?.db },
    { key: "temporal", label: t("temporal"), state: health?.temporal },
    { key: "worker", label: t("worker"), state: health?.worker },
  ];

  return (
    <div className="flex items-center gap-3 text-[11px] text-zinc-500">
      {items.map((item) => {
        const ok = item.state === "ok";
        const bad = item.state === "error" || item.state === "down";
        return (
          <span key={item.key} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                ok && "bg-emerald-400",
                bad && "bg-red-400",
                !ok && !bad && "bg-zinc-600",
              )}
            />
            {item.label}
          </span>
        );
      })}
      {health ? (
        <span className="hidden font-mono uppercase tracking-wide text-zinc-600 lg:inline">
          {health.blobBackend}
        </span>
      ) : null}
    </div>
  );
}
