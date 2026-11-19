"use client";

import { SinceLabel } from "@/components/world/world-status";
import type { LiveAgent } from "@/lib/office-live";
import { cn } from "@/lib/utils";
import { shortStage } from "@/lib/world-state";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { STATUS_DOT, STATUS_I18N } from "./status";

/**
 * Text-first station list (97 §3.1). It is the `?view=list` view on every
 * viewport and the below-`md` fallback on the floor, so station inspection
 * never depends on the pixel grid rendering or on a wide screen. Status is
 * always spelled out, never colour-only.
 */
export function OfficeListView({
  agents,
  selectedId,
  onSelect,
  onOpen,
  className,
}: {
  agents: LiveAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (agent: LiveAgent) => void;
  className?: string;
}) {
  const t = useTranslations("office");
  return (
    <div className={cn("space-y-2", className)}>
      <p className="font-mono text-[10px] text-px-faint">{t("listHint")}</p>
      <ul className="space-y-1">
        {agents.map((agent) => {
          const selected = selectedId === agent.id;
          return (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(agent.id);
                  onOpen(agent);
                }}
                aria-current={selected ? "true" : undefined}
                aria-label={`${agent.id} · ${t(STATUS_I18N[agent.status])} · ${t("clickToInspect")}`}
                className={cn(
                  "flex w-full items-center gap-2 border border-px-line bg-px-panel px-2 py-1.5 text-left font-mono text-[10px] text-px-muted transition-colors hover:border-px-line3 hover:text-px-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-px-cream",
                  selected && "border-emerald-500/40 text-px-text",
                )}
              >
                <span className={cn("size-1.5", STATUS_DOT[agent.status])} />
                <span className="w-20 truncate text-px-text">{agent.id}</span>
                <span className="w-16 shrink-0 text-px-muted">
                  {t(STATUS_I18N[agent.status])}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {shortStage(agent.stageId ?? agent.activityDetail ?? null) ||
                    "—"}
                </span>
                <span className="hidden max-w-[7rem] truncate text-px-faint sm:block">
                  {agent.currentTool ?? agent.model}
                </span>
                {agent.since ? (
                  <span className="hidden text-px-faint sm:block">
                    <SinceLabel since={agent.since} />
                  </span>
                ) : null}
                <span className="flex shrink-0 items-center gap-0.5 text-px-faint">
                  {t("listOpen")}
                  <ChevronRight className="size-3" aria-hidden="true" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
