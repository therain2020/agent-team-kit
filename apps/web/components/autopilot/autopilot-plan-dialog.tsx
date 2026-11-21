"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type AutoApprove,
  autoApproveCoveredOrigins,
  autoApproveForSave,
  normalizeAutoApprove,
  requiresScopeAllConfirmation,
  resolveAutoApproveScope,
  withoutRunCost,
} from "@/lib/auto-approve-scope";
import type { AutopilotConfig } from "@kit/core";
import { isCronExpression } from "@kit/core/cron";
import {
  ArrowLeft,
  CalendarClock,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

type Schedule = AutopilotConfig["schedules"][number];

export function AutopilotPlanDialog({
  packDir,
  packName,
  enabled,
  config,
  workflows,
}: {
  packDir: string;
  packName: string;
  enabled: boolean;
  config: AutopilotConfig;
  workflows: Array<{ id: string; stages: number }>;
}) {
  const t = useTranslations("autopilotPlan");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<AutopilotConfig | null>(null);
  const [rationale, setRationale] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [daemonEnabled, setDaemonEnabled] = useState(false);
  const [autoApprove, setAutoApprove] = useState<AutoApprove>(
    normalizeAutoApprove(),
  );
  const [confirmScopeAll, setConfirmScopeAll] = useState(false);
  const [confirmRisk, setConfirmRisk] = useState(false);
  const [pending, setPending] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const autoApproveScope = resolveAutoApproveScope(autoApprove);
  const scopeAllConfirmation = requiresScopeAllConfirmation(autoApproveScope);
  const risky =
    daemonEnabled ||
    autoApprove.enabled ||
    schedules.some((schedule) => schedule.mode === "LIVE");
  const cronInvalid = schedules.some(
    (schedule) => !isCronExpression(schedule.cron),
  );
  const timezoneInvalid = !/^([A-Za-z]+(\/[A-Za-z0-9_+-]+)+|UTC)$/.test(
    timezone.trim(),
  );

  function reset() {
    setStep("intent");
    setDraft(null);
    setIntent("");
    setWarnings([]);
    setError(null);
    setConfirmRisk(false);
    setConfirmScopeAll(false);
  }

  function adopt(values: AutopilotConfig) {
    setDraft(values);
    setSchedules(values.schedules ?? []);
    setTimezone(values.timezone || "UTC");
    setDaemonEnabled(values.enabled === true);
    setAutoApprove(normalizeAutoApprove(values.approval?.autoApprove));
    // A fresh draft is a fresh approval: re-confirm `scope: all` explicitly.
    setConfirmScopeAll(false);
  }

  async function generate() {
    setError(null);
    if (!intent.trim()) {
      setError(t("intentPlaceholder"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "autopilot",
          intent: intent.trim(),
          packDir,
        }),
      });
      const payload = (await response.json()) as {
        values?: AutopilotConfig;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("failed"));
      }
      adopt(payload.values);
      setRationale(payload.rationale ?? "");
      setWarnings(payload.warnings ?? []);
      setModel(payload.model === "live" ? "live" : "heuristic");
      setConfirmRisk(false);
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  async function save() {
    if (!draft) {
      return;
    }
    if (cronInvalid) {
      setError(t("cronInvalid"));
      return;
    }
    if (timezoneInvalid) {
      setError(t("timezoneInvalid"));
      return;
    }
    if (schedules.length === 0) {
      setError(t("noSchedules"));
      return;
    }
    if (scopeAllConfirmation && !confirmScopeAll) {
      setError(t("scopeAllWarning"));
      return;
    }
    setError(null);
    setPending("save");
    try {
      const next: AutopilotConfig = {
        ...draft,
        timezone,
        enabled: daemonEnabled,
        schedules,
        approval: {
          ...(draft.approval ?? {}),
          autoApprove: autoApproveForSave(autoApprove),
        },
      };
      const response = await fetch(
        `/api/packs/${encodeURIComponent(packDir)}/autopilot`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: next, confirmRisk }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("failed"));
      }
      let syncFailed = false;
      if (daemonEnabled !== enabled) {
        const sync = await fetch("/api/autopilot", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ packDir, enabled: daemonEnabled }),
        });
        syncFailed = !sync.ok;
      }
      toast.success(t("saved", { pack: packName }), {
        description: syncFailed ? t("daemonSyncFailed") : undefined,
      });
      setOpen(false);
      reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  function updateSchedule(index: number, patch: Partial<Schedule>) {
    setSchedules((current) =>
      current.map((schedule, item) =>
        item === index ? { ...schedule, ...patch } : schedule,
      ),
    );
  }

  function updateBudget(
    index: number,
    key: "dailyRuns" | "dailyCostCny",
    raw: string,
  ) {
    const value = raw.trim() === "" ? undefined : Number(raw);
    setSchedules((current) =>
      current.map((schedule, item) => {
        if (item !== index) {
          return schedule;
        }
        const budget = { ...(schedule.budget ?? {}) };
        if (value === undefined || !Number.isFinite(value)) {
          delete budget[key];
        } else {
          budget[key] = value;
        }
        const cleaned = Object.keys(budget).length > 0 ? budget : undefined;
        return {
          ...schedule,
          ...(cleaned ? { budget: cleaned } : { budget: undefined }),
        };
      }),
    );
  }

  function addSchedule() {
    const workflow = workflows[0]?.id;
    if (!workflow) {
      return;
    }
    const id = `schedule-${schedules.length + 1}`;
    setSchedules((current) => [
      ...current,
      { id, workflow, cron: "0 9 * * *", mode: "DRY_RUN" },
    ]);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={workflows.length === 0}>
          <CalendarClock className="size-3.5" />
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title", { pack: packName })}</DialogTitle>
          <DialogDescription>
            {step === "intent" ? t("description") : t("reviewDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "intent" ? (
          <Textarea
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder={t("intentPlaceholder")}
            className="min-h-28 text-sm"
          />
        ) : (
          <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                <Badge variant="violet">{packName}</Badge>
                <Badge variant={model === "live" ? "success" : "outline"}>
                  {model === "live" ? t("aiProposal") : t("heuristicProposal")}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-zinc-200">{intent}</p>
              <p className="mt-1 text-[11px] text-zinc-400">{rationale}</p>
            </div>

            {warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {t("schedules")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  onClick={addSchedule}
                  disabled={workflows.length === 0}
                >
                  <Plus className="size-3" />
                  {t("addSchedule")}
                </Button>
              </div>
              {schedules.length === 0 ? (
                <p className="rounded border border-dashed border-border px-3 py-4 text-center text-[11px] text-zinc-500">
                  {t("noSchedules")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {schedules.map((schedule, index) => (
                    <li
                      key={`${schedule.id}-${index}`}
                      className="rounded-md border border-border px-2 py-2"
                    >
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_6rem_5rem_5rem_auto]">
                        <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          {t("workflow")}
                          <select
                            value={schedule.workflow}
                            onChange={(event) =>
                              updateSchedule(index, {
                                workflow: event.target.value,
                              })
                            }
                            className="h-8 w-full rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] normal-case text-zinc-200"
                          >
                            {workflows.map((workflow) => (
                              <option key={workflow.id} value={workflow.id}>
                                {workflow.id}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          {t("cron")}
                          <Input
                            aria-label={t("cron")}
                            value={schedule.cron}
                            onChange={(event) =>
                              updateSchedule(index, {
                                cron: event.target.value,
                              })
                            }
                            className={`h-8 font-mono text-[11px] ${
                              isCronExpression(schedule.cron)
                                ? ""
                                : "border-red-500/50"
                            }`}
                          />
                        </div>
                        <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          {t("mode")}
                          <select
                            value={schedule.mode}
                            onChange={(event) =>
                              updateSchedule(index, {
                                mode:
                                  event.target.value === "LIVE"
                                    ? "LIVE"
                                    : "DRY_RUN",
                              })
                            }
                            className="h-8 w-full rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] normal-case text-zinc-200"
                          >
                            <option value="DRY_RUN">DRY_RUN</option>
                            <option value="LIVE">LIVE</option>
                          </select>
                        </label>
                        <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          {t("dailyRuns")}
                          <Input
                            aria-label={t("dailyRuns")}
                            type="number"
                            min={1}
                            max={24}
                            value={schedule.budget?.dailyRuns ?? ""}
                            onChange={(event) =>
                              updateBudget(
                                index,
                                "dailyRuns",
                                event.target.value,
                              )
                            }
                            className="h-8 text-[11px]"
                          />
                        </div>
                        <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          {t("dailyCost")}
                          <Input
                            aria-label={t("dailyCost")}
                            type="number"
                            min={0}
                            step="0.5"
                            value={schedule.budget?.dailyCostCny ?? ""}
                            onChange={(event) =>
                              updateBudget(
                                index,
                                "dailyCostCny",
                                event.target.value,
                              )
                            }
                            className="h-8 text-[11px]"
                          />
                        </div>
                        <div className="flex items-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-red-300/80 hover:text-red-200"
                            onClick={() =>
                              setSchedules((current) =>
                                current.filter((_, item) => item !== index),
                              )
                            }
                            aria-label={t("removeSchedule")}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("timezone")}
                <Input
                  aria-label={t("timezone")}
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  className="h-8 font-mono text-[11px]"
                />
              </div>
              <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("maxRunCost")}
                <Input
                  aria-label={t("maxRunCost")}
                  type="number"
                  min={0}
                  step="0.5"
                  value={autoApprove.maxRunCostCny ?? ""}
                  onChange={(event) =>
                    setAutoApprove((current) => {
                      const raw = event.target.value.trim();
                      if (raw === "") {
                        return withoutRunCost(current);
                      }
                      return { ...current, maxRunCostCny: Number(raw) };
                    })
                  }
                  disabled={!autoApprove.enabled}
                  className="h-8 text-[11px] disabled:opacity-50"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border px-3 py-2">
              <label className="flex items-start gap-2 text-[11px] text-zinc-300">
                <input
                  type="checkbox"
                  checked={daemonEnabled}
                  onChange={(event) => setDaemonEnabled(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-emerald-500"
                />
                <span>
                  {t("enableDaemon")}
                  <span className="mt-0.5 block text-[10px] text-zinc-600">
                    {t("enableDaemonHint")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[11px] text-zinc-300">
                <input
                  type="checkbox"
                  checked={autoApprove.enabled}
                  onChange={(event) =>
                    setAutoApprove((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                  className="mt-0.5 size-3.5 accent-amber-500"
                />
                <span>
                  {t("autoApprove")}
                  <span className="mt-0.5 block text-[10px] text-zinc-600">
                    {t("autoApproveHint")}
                  </span>
                </span>
              </label>
              <p className="pl-5 text-[10px] text-zinc-400">
                {t("scopeSummary", {
                  scope: t(
                    autoApproveScope === "all" ? "scopeAll" : "scopeScheduled",
                  ),
                  origins: autoApproveCoveredOrigins(autoApproveScope)
                    .map((kind) => t(`origin_${kind}`))
                    .join(" · "),
                })}
              </p>
              <label className="block space-y-1 pl-5 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("scope")}
                <select
                  value={autoApproveScope}
                  onChange={(event) =>
                    setAutoApprove((current) => ({
                      ...current,
                      scope: event.target.value === "all" ? "all" : "scheduled",
                    }))
                  }
                  className="h-8 w-full rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] normal-case text-zinc-200"
                >
                  <option value="scheduled">{t("scopeScheduled")}</option>
                  <option value="all">{t("scopeAll")}</option>
                </select>
              </label>
              {scopeAllConfirmation ? (
                <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200">
                  <p>{t("scopeAllWarning")}</p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={confirmScopeAll}
                      onChange={(event) =>
                        setConfirmScopeAll(event.target.checked)
                      }
                      className="mt-0.5 size-3.5 accent-amber-500"
                    />
                    <span>{t("scopeAllConfirm")}</span>
                  </label>
                </div>
              ) : null}
              {autoApprove.enabled ? (
                <label className="block space-y-1 pl-5 text-[10px] uppercase tracking-wider text-zinc-500">
                  {t("maxRisk")}
                  <select
                    value={autoApprove.maxRisk}
                    onChange={(event) =>
                      setAutoApprove((current) => ({
                        ...current,
                        maxRisk:
                          event.target.value === "medium" ? "medium" : "low",
                      }))
                    }
                    className="h-8 w-full rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] normal-case text-zinc-200"
                  >
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                  </select>
                </label>
              ) : null}
              <p className="text-[10px] text-zinc-600">
                {t("preserved", {
                  iterations: draft?.iterations?.length ?? 0,
                  evolution: draft?.evolution?.enabled ? "on" : "off",
                })}
              </p>
            </div>

            {risky ? (
              <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                <input
                  type="checkbox"
                  checked={confirmRisk}
                  onChange={(event) => setConfirmRisk(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-amber-500"
                />
                <span>{t("riskConfirm")}</span>
              </label>
            ) : null}

            {error ? <ErrorLine message={error} /> : null}
          </div>
        )}

        {step === "intent" && error ? <ErrorLine message={error} /> : null}

        <DialogFooter>
          {step === "intent" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending !== null}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <CalendarClock className="size-3.5" />
                {pending === "draft" ? t("generating") : t("generate")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStep("intent");
                  setError(null);
                }}
                disabled={pending !== null}
              >
                <ArrowLeft className="size-3.5" />
                {t("back")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <RefreshCw className="size-3.5" />
                {t("regenerate")}
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={
                  pending !== null ||
                  cronInvalid ||
                  timezoneInvalid ||
                  schedules.length === 0 ||
                  (risky && !confirmRisk) ||
                  (scopeAllConfirmation && !confirmScopeAll)
                }
              >
                {pending === "save" ? t("saving") : t("approve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
