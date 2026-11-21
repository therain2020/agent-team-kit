"use client";

import {
  PixelAgent,
  PixelDoor,
  PixelMotionProvider,
  PixelMotionToggle,
  PixelWorkpiece,
  PixelWorld,
  WorldHud,
  agentSeed,
  usePixelMotion,
} from "@/components/pixel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type FactoryItem,
  type FactoryStationId,
  stationsFor,
} from "@/lib/factory";
import { officeAgentHref } from "@/lib/office-deeplink";
import { cn, formatCny, timeAgo } from "@/lib/utils";
import {
  CheckCircle2,
  CircleAlert,
  Gamepad2,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";

const STATION_I18N: Record<
  FactoryStationId,
  | "stationDemand"
  | "stationBuild"
  | "stationQa"
  | "stationGatekeeper"
  | "stationDeliver"
> = {
  demand: "stationDemand",
  build: "stationBuild",
  qa: "stationQa",
  gatekeeper: "stationGatekeeper",
  deliver: "stationDeliver",
};

interface FactoryViewProps {
  items: FactoryItem[];
  /** Approvals ordered by risk: the conveyor order and keyboard order. */
  gate: FactoryItem[];
  activeId: string | null;
  pending: boolean;
  refreshing: boolean;
  shift: { approved: number; rejected: number };
  /** Factory → office door, preselected on the active producer when known. */
  officeHref: string;
  onActivate: (requestId: string) => void;
  onOpen: (item: FactoryItem) => void;
  onApprove: (item: FactoryItem) => void;
  onReject: (item: FactoryItem) => void;
  onBatch: () => void;
  onRefresh: () => void;
}

/**
 * Factory view of the approvals surface: the pixel conveyor from #148, driven
 * by the shared world stream. Selection, decisions and the drawer live in
 * `ApprovalsSurface` so both views stay in lockstep.
 *
 * The view is wrapped in the shared motion provider so the belt treads, the
 * workpiece palette and the reduced-motion switch are the same primitives the
 * office uses (97 §3.1, 89 F-5).
 */
export function FactoryView(props: FactoryViewProps) {
  return (
    <PixelMotionProvider>
      <FactoryViewBody {...props} />
    </PixelMotionProvider>
  );
}

function FactoryViewBody({
  items,
  gate,
  activeId,
  pending,
  refreshing,
  shift,
  officeHref,
  onActivate,
  onOpen,
  onApprove,
  onReject,
  onBatch,
  onRefresh,
}: FactoryViewProps) {
  const t = useTranslations("factory");
  const riskT = useTranslations("risk");
  const locale = useLocale();
  const { enabled: motionEnabled } = usePixelMotion();
  const blocked = useMemo(
    () => items.filter((item) => item.kind === "failed"),
    [items],
  );
  const stations = useMemo(() => stationsFor(items), [items]);
  const selected = gate.find((item) => item.requestId === activeId) ?? gate[0];
  const gateCost = gate.reduce((sum, item) => sum + item.costCny, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="hidden font-mono text-[10px] uppercase text-zinc-500 sm:inline">
          {t("shortcuts")}
        </span>
        <PixelMotionToggle />
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing || pending}
          aria-label={t("refresh")}
        >
          <RefreshCw
            className={cn(
              "size-3.5",
              refreshing && "animate-spin motion-reduce:animate-none",
            )}
          />
          {t("refresh")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onBatch}
          disabled={pending}
        >
          <CheckCircle2 className="size-3.5" />
          {t("batch")}
        </Button>
      </div>

      <div className="flex items-stretch gap-1 overflow-x-auto border-2 border-zinc-800 bg-zinc-950 p-1.5">
        {stations.map((station, index) => (
          <div key={station.id} className="flex items-center gap-1">
            <div
              className={cn(
                "min-w-24 border px-2 py-1 font-mono text-[9px] uppercase tracking-wide",
                station.count > 0
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
                  : "border-zinc-800 text-zinc-600",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{t(STATION_I18N[station.id])}</span>
                <span>{station.count}</span>
              </span>
            </div>
            {index < stations.length - 1 ? (
              <span className="text-zinc-700">→</span>
            ) : null}
          </div>
        ))}
      </div>

      <PixelWorld
        title={t("title")}
        subtitle={t("conveyor")}
        hud={
          <WorldHud
            items={[
              {
                key: "pending",
                label: t("pendingLabel"),
                value: gate.length,
                tone: gate.length > 0 ? "warn" : "default",
              },
              {
                key: "approved",
                label: t("approvedCount"),
                value: shift.approved,
                tone: "good",
              },
              {
                key: "rejected",
                label: t("rejectedCount"),
                value: shift.rejected,
                tone: "bad",
              },
              {
                key: "cost",
                label: t("cost"),
                value: formatCny(gateCost),
              },
            ]}
          />
        }
        doors={
          <PixelDoor
            href={officeHref}
            label={t("backOffice")}
            icon={<Gamepad2 className="size-3.5" aria-hidden="true" />}
            shortcut="O"
          />
        }
      >
        <div className="mb-2 flex items-center justify-end font-mono text-[10px] uppercase tracking-widest text-zinc-500">
          <span>
            {t("gatekeeper")} · {gate.length}
          </span>
        </div>

        <div
          className={cn(
            "factory-belt hidden min-h-44 items-stretch gap-2 overflow-x-auto border-y-2 border-zinc-800 p-3 md:flex",
            motionEnabled && "factory-belt-run",
          )}
          aria-live="polite"
        >
          {gate.length === 0 ? (
            <div className="flex w-full items-center justify-center gap-2 font-mono text-xs text-zinc-600">
              <CheckCircle2 className="size-4" />
              {t("empty")}
            </div>
          ) : (
            gate.map((item) => {
              const active = selected?.requestId === item.requestId;
              return (
                <div key={item.requestId} className="flex min-w-52 flex-col">
                  <button
                    type="button"
                    onClick={() => {
                      if (item.requestId) {
                        onActivate(item.requestId);
                      }
                      onOpen(item);
                    }}
                    className={cn(
                      "flex-1 border-2 px-3 py-2 text-left font-mono transition-colors",
                      active
                        ? "border-emerald-400 bg-emerald-500/10"
                        : "border-zinc-700 bg-zinc-900 hover:border-zinc-500",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-200">
                        <ProducerSprite item={item} />
                        <span className="truncate">
                          {item.stageName ?? item.workflowId ?? item.runId}
                        </span>
                      </span>
                      <Badge
                        variant={
                          item.riskClass === "high"
                            ? "danger"
                            : item.riskClass === "medium"
                              ? "warning"
                              : "outline"
                        }
                        className="rounded-none text-[9px] uppercase"
                      >
                        {riskT(item.riskClass)}
                      </Badge>
                    </div>
                    <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-zinc-400">
                      {item.summary}
                    </p>
                    <div className="mt-2 flex items-center justify-between text-[9px] text-zinc-600">
                      <span>{formatCny(item.costCny)}</span>
                      <span>{timeAgo(item.updatedAt, locale)}</span>
                    </div>
                  </button>
                  <ProducerOfficeLink item={item} />
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-2 md:hidden" aria-live="polite">
          {gate.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-4 font-mono text-xs text-zinc-600">
              <CheckCircle2 className="size-4" />
              {t("empty")}
            </div>
          ) : (
            gate.map((item) => (
              <div
                key={item.requestId}
                className={cn(
                  "border-2 p-2",
                  selected?.requestId === item.requestId
                    ? "border-emerald-400 bg-emerald-500/10"
                    : "border-zinc-700 bg-zinc-900",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (item.requestId) {
                      onActivate(item.requestId);
                    }
                    onOpen(item);
                  }}
                  className="flex w-full items-start gap-2 text-left"
                >
                  <ProducerSprite item={item} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-200">
                      <span className="truncate">
                        {item.stageName ?? item.workflowId ?? item.runId}
                      </span>
                      <Badge
                        variant={
                          item.riskClass === "high"
                            ? "danger"
                            : item.riskClass === "medium"
                              ? "warning"
                              : "outline"
                        }
                        className="rounded-none text-[9px] uppercase"
                      >
                        {riskT(item.riskClass)}
                      </Badge>
                    </span>
                    <span className="mt-1 block line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
                      {item.summary}
                    </span>
                    <span className="mt-1 flex justify-between text-[9px] text-zinc-600">
                      <span>{formatCny(item.costCny)}</span>
                      <span>{timeAgo(item.updatedAt, locale)}</span>
                    </span>
                  </span>
                </button>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => onApprove(item)}
                    disabled={pending}
                  >
                    <CheckCircle2 className="size-3.5" />
                    {t("approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 border-red-500/30 text-red-300 hover:bg-red-500/10"
                    onClick={() => onReject(item)}
                    disabled={pending}
                  >
                    <XCircle className="size-3.5" />
                    {t("abort")}
                  </Button>
                </div>
                <ProducerOfficeLink item={item} />
              </div>
            ))
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-2 border-zinc-800 bg-zinc-950 p-3">
          <ShieldAlert className="size-4 text-amber-300" />
          <span className="font-mono text-[10px] uppercase text-zinc-500">
            {t("gatekeeper")}
          </span>
          {selected ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {selected.summary}
              </span>
              <Button
                size="sm"
                onClick={() => onApprove(selected)}
                disabled={pending}
              >
                <CheckCircle2 className="size-3.5" />
                {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                onClick={() => onReject(selected)}
                disabled={pending}
              >
                <XCircle className="size-3.5" />
                {t("abort")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpen(selected)}
                disabled={pending}
              >
                <ScrollText className="size-3.5" />
                {t("evidence")}
              </Button>
            </>
          ) : (
            <span className="text-xs text-zinc-600">{t("empty")}</span>
          )}
        </div>
      </PixelWorld>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border-2 border-zinc-800 bg-[#0d1117] p-3">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-red-300">
            <CircleAlert className="size-4" />
            {t("blocked")} · {blocked.length}
          </h2>
          <div className="mt-2 space-y-2">
            {blocked.length === 0 ? (
              <p className="text-xs text-zinc-600">{t("blockedEmpty")}</p>
            ) : (
              blocked.map((item) => (
                <button
                  key={`${item.runId}-${item.updatedAt}`}
                  type="button"
                  onClick={() => onOpen(item)}
                  className="block w-full border border-red-500/20 bg-red-500/5 px-3 py-2 text-left font-mono text-[11px] text-zinc-400 transition-colors hover:border-red-500/40"
                >
                  <span className="flex items-center gap-2">
                    <ProducerSprite item={item} />
                    <span className="text-zinc-200">{item.summary}</span>
                  </span>
                  <span className="mt-1 flex justify-between text-[9px] text-zinc-600">
                    <span>{item.runId}</span>
                    <span>{timeAgo(item.updatedAt, locale)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="border-2 border-zinc-800 bg-[#0d1117] p-3">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-emerald-300">
            <CheckCircle2 className="size-4" />
            {t("done")}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase text-zinc-500">
            <span>
              {t("approvedCount")}{" "}
              <span className="text-emerald-300">{shift.approved}</span>
            </span>
            <span>
              {t("rejectedCount")}{" "}
              <span className="text-red-300">{shift.rejected}</span>
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-600">{t("doneHint")}</p>
        </section>
      </div>
    </div>
  );
}

/**
 * Producer portrait (97 §3.5): the same shared sprite the office draws, with
 * the same id seed, so a person looks identical in both rooms. Unknown owners
 * fall back to the generic workpiece crate — never an inferred avatar.
 */
function ProducerSprite({ item }: { item: FactoryItem }) {
  if (!item.producerAgentId) {
    return <PixelWorkpiece item={item} size={24} />;
  }
  return (
    <span
      className="inline-flex shrink-0 items-end"
      title={item.producerAgentId}
    >
      <PixelAgent
        seed={agentSeed(item.producerAgentId)}
        state="idle"
        scale={0.5}
      />
    </span>
  );
}

/** "View office" jumps to the producer's station through the office deep link. */
function ProducerOfficeLink({ item }: { item: FactoryItem }) {
  const t = useTranslations("factory");
  if (!item.producerAgentId) {
    return null;
  }
  return (
    <Link
      href={officeAgentHref(item.producerAgentId)}
      className="mt-1 block border border-zinc-800 px-2 py-1 font-mono text-[9px] text-zinc-500 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
    >
      {t("viewOffice")} · {item.producerAgentId}
    </Link>
  );
}
