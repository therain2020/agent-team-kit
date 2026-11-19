import { Badge } from "@/components/ui/badge";
import type { CapacityOverview } from "@/lib/capacity-math";
import { quotaPressure } from "@/lib/capacity-math";
import type { PriorityClass } from "@kit/core";
import { useTranslations } from "next-intl";

const PRIORITIES: PriorityClass[] = ["P0", "P1", "P2", "P3"];

/** Minimal, read-only capacity view: queue depth, wait p95, quotas, priorities. */
export function CapacitySection({ overview }: { overview: CapacityOverview }) {
  const t = useTranslations("opsSurface");
  const workspaces = Object.entries(overview.queue.byWorkspace).sort(
    (a, b) => b[1].queued + b[1].inFlight - (a[1].queued + a[1].inFlight),
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          label={t("capacityQueueDepth")}
          value={overview.queue.queueDepth}
        />
        <Metric label={t("capacityInFlight")} value={overview.queue.inFlight} />
        <Metric
          label={t("capacityWaitP95")}
          value={`${overview.queue.waitP95Ms} ms`}
        />
        <Metric
          label={t("capacityWaitMax")}
          value={`${overview.queue.maxWaitMs} ms`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>{t("capacityPriorityTitle")}</span>
        {PRIORITIES.map((priority) => (
          <Badge
            key={priority}
            variant={
              overview.queue.byPriority[priority] > 0 ? "warning" : "default"
            }
          >
            {priority} · {overview.queue.byPriority[priority]}
          </Badge>
        ))}
      </div>

      {workspaces.length === 0 ? (
        <p className="text-[11px] text-zinc-500">{t("capacityQueueEmpty")}</p>
      ) : (
        <table className="w-full text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr>
              <th className="font-normal">{t("capacityWorkspace")}</th>
              <th className="font-normal">{t("capacityQueued")}</th>
              <th className="font-normal">{t("capacityInFlight")}</th>
              <th className="font-normal">{t("capacityRpm")}</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {workspaces.map(([workspaceId, lane]) => (
              <tr key={workspaceId} className="border-t border-border/40">
                <td className="py-1 font-mono">{workspaceId}</td>
                <td className="py-1">{lane.queued}</td>
                <td className="py-1">{lane.inFlight}</td>
                <td className="py-1">{lane.rpm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          {t("capacityQuotaTitle")}
        </h3>
        {overview.quotas.length === 0 ? (
          <p className="text-[11px] text-zinc-500">{t("capacityQuotaNone")}</p>
        ) : (
          <ul className="space-y-1 text-[11px] text-zinc-300">
            {overview.quotas.map((quota) => {
              const pressure = quotaPressure(quota, overview.queue);
              return (
                <li
                  key={`${quota.workspaceId}:${quota.provider}:${quota.model}`}
                  className="flex flex-wrap items-center gap-2 border-t border-border/40 py-1"
                >
                  <span className="font-mono">
                    {quota.workspaceId} / {quota.provider} / {quota.model}
                  </span>
                  <span className="text-zinc-500">
                    rpm {quota.rpm ?? "∞"} · tpm {quota.tpm ?? "∞"} ·
                    concurrency {quota.concurrency ?? "∞"}
                  </span>
                  <Badge
                    variant={quota.overflow === "queue" ? "default" : "warning"}
                  >
                    {quota.overflow}
                  </Badge>
                  {pressure !== null ? (
                    <span
                      className={
                        pressure >= 1 ? "text-amber-300" : "text-zinc-500"
                      }
                    >
                      {t("capacityQuotaUsage", {
                        percent: Math.round(pressure * 100),
                      })}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border border-border/50 bg-zinc-950/30 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className="font-mono text-sm text-zinc-200">{value}</div>
    </div>
  );
}
