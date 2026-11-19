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
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { OptimisticMission } from "@/lib/office-live";
import type { AgentRole } from "@kit/core";
import { ArrowLeft, Play, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface MissionValues {
  workflow: string;
  manager: string;
  sellers: string[];
  builders: string[];
  specialists: string[];
  acceptance: string;
}

/** Only the fields the dialog needs; live agents satisfy this shape. */
interface MissionAgentOption {
  id: string;
  isManager: boolean;
  role: AgentRole;
}

export function NewMissionDialog({
  open,
  onOpenChange,
  packDir,
  workflows,
  agents,
  roleRules,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packDir: string;
  workflows: Array<{ id: string; stages: number }>;
  agents: MissionAgentOption[];
  roleRules: {
    requireSeller: boolean;
    requireBuilder: boolean;
    allowCombined: boolean;
  };
  /** Emitted after the job starts so the office can show it optimistically. */
  onStarted?: (mission: OptimisticMission) => void;
}) {
  const t = useTranslations("newMission");
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [intent, setIntent] = useState("");
  const [evidence, setEvidence] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const [values, setValues] = useState<MissionValues | null>(null);
  const [rationale, setRationale] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [pending, setPending] = useState<"draft" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep("intent");
      setValues(null);
      setError(null);
    }
  }, [open]);

  const managerOptions = [
    "manager",
    ...agents.filter((agent) => agent.isManager).map((agent) => agent.id),
  ];
  const sellerOptions = agents.filter(
    (agent) =>
      !agent.isManager && (agent.role === "seller" || roleRules.allowCombined),
  );
  const builderOptions = agents.filter(
    (agent) =>
      !agent.isManager && (agent.role === "builder" || roleRules.allowCombined),
  );
  const specialistOptions = agents.filter(
    (agent) => !agent.isManager && agent.role === "specialist",
  );

  function toggle(list: string[], id: string): string[] {
    return list.includes(id)
      ? list.filter((item) => item !== id)
      : [...list, id];
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
          kind: "mission",
          intent: intent.trim(),
          packDir,
        }),
      });
      const payload = (await response.json()) as {
        values?: MissionValues;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("failed"));
      }
      setValues(payload.values);
      setRationale(payload.rationale ?? "");
      setWarnings(payload.warnings ?? []);
      setModel(payload.model === "live" ? "live" : "heuristic");
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  async function submit() {
    if (!values) {
      return;
    }
    setError(null);
    const seller = values.sellers[0] ?? "";
    if (roleRules.requireSeller && !seller) {
      setError(t("sellerRequired"));
      return;
    }
    if (roleRules.requireBuilder && values.builders.length === 0) {
      setError(t("builderRequired"));
      return;
    }
    if (
      !roleRules.allowCombined &&
      seller &&
      values.builders.includes(seller)
    ) {
      setError(t("combinedForbidden"));
      return;
    }

    setPending("start");
    try {
      const assigned = [
        ...new Set([
          ...(seller ? [seller] : []),
          ...values.builders,
          ...values.specialists,
        ]),
      ];
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "packRun",
          packDir,
          workflow: values.workflow,
          acceptance: values.acceptance || undefined,
          goal: intent.trim(),
          evidenceText: evidence.trim() || undefined,
          mission: {
            manager: values.manager,
            sellers: seller ? [seller] : [],
            builders: values.builders,
            specialists: values.specialists,
            agents: assigned,
          },
        }),
      });
      const payload = (await response.json()) as {
        jobId?: string;
        error?: string;
        details?: string[];
      };
      if (!response.ok || !payload.jobId) {
        throw new Error(
          [payload.error, ...(payload.details ?? [])]
            .filter(Boolean)
            .join("\n") || t("failed"),
        );
      }
      onStarted?.({
        runId: payload.jobId,
        workflowId: values.workflow,
        goal: intent.trim(),
        acceptance: values.acceptance || undefined,
        createdAt: new Date().toISOString(),
        manager: values.manager,
        sellers: seller ? [seller] : [],
        builders: values.builders,
        specialists: values.specialists,
        agents: assigned,
      });
      toast.success(t("started", { runId: payload.jobId }));
      onOpenChange(false);
      setIntent("");
      setAcceptance("");
      setEvidence("");
      setShowEvidence(false);
      setValues(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  const setAcceptance = (acceptance: string) =>
    setValues((current) => (current ? { ...current, acceptance } : current));
  const setWorkflow = (workflow: string) =>
    setValues((current) => (current ? { ...current, workflow } : current));
  const setManager = (manager: string) =>
    setValues((current) => (current ? { ...current, manager } : current));
  const setSeller = (seller: string) =>
    setValues((current) =>
      current ? { ...current, sellers: seller ? [seller] : [] } : current,
    );
  const setList = (key: "builders" | "specialists", id: string) =>
    setValues((current) =>
      current ? { ...current, [key]: toggle(current[key], id) } : current,
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setError(null);
          setStep("intent");
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {step === "intent"
              ? t("intentPlaceholder")
              : t("reviewDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "intent" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="mission-intent"
                className="text-xs font-medium text-zinc-300"
              >
                {t("intent")}
              </label>
              <Textarea
                id="mission-intent"
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("goalPlaceholder")}
                className="min-h-24 text-sm"
              />
            </div>

            <button
              type="button"
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={() => setShowEvidence((value) => !value)}
            >
              {t("evidenceToggle")}
            </button>
            {showEvidence ? (
              <Textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder='{"sources":[...]}'
                className="min-h-24 font-mono text-[11px]"
              />
            ) : null}

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : values ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                <Badge variant="violet">{packDir}</Badge>
                <Badge variant={model === "live" ? "success" : "outline"}>
                  {model === "live" ? t("aiProposal") : t("heuristicProposal")}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-zinc-200">{intent}</p>
              {rationale ? (
                <p className="mt-1 text-[11px] text-zinc-400">{rationale}</p>
              ) : null}
            </div>

            {warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  htmlFor="mission-workflow"
                  className="text-xs font-medium text-zinc-300"
                >
                  {t("workflow")}
                </label>
                <select
                  id="mission-workflow"
                  value={values.workflow}
                  onChange={(event) => setWorkflow(event.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
                >
                  {workflows.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id} · {item.stages}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="mission-manager"
                  className="text-xs font-medium text-zinc-300"
                >
                  {t("manager")}
                </label>
                <select
                  id="mission-manager"
                  value={values.manager}
                  onChange={(event) => setManager(event.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
                >
                  {managerOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="mission-seller"
                className="text-xs font-medium text-zinc-300"
              >
                {t("seller")}
              </label>
              <select
                id="mission-seller"
                value={values.sellers[0] ?? ""}
                onChange={(event) => setSeller(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
              >
                {sellerOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.id}
                  </option>
                ))}
                {roleRules.requireSeller ? null : (
                  <option value="">{t("noSeller")}</option>
                )}
              </select>
            </div>

            <PersonPicker
              label={t("builders")}
              agents={builderOptions}
              selected={values.builders}
              onToggle={(id) => setList("builders", id)}
              empty={t("noBuilders")}
            />
            <PersonPicker
              label={t("specialists")}
              agents={specialistOptions}
              selected={values.specialists}
              onToggle={(id) => setList("specialists", id)}
              empty={t("noSpecialists")}
            />

            <div className="space-y-1.5">
              <label
                htmlFor="mission-acceptance"
                className="text-xs font-medium text-zinc-300"
              >
                {t("acceptance")}
              </label>
              <Textarea
                id="mission-acceptance"
                value={values.acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
                placeholder={t("acceptancePlaceholder")}
                className="min-h-16 text-xs"
              />
            </div>

            {showEvidence ? null : evidence.trim() ? (
              <p className="text-[10px] text-zinc-500">
                {t("evidence")}: {evidence.length} chars
              </p>
            ) : null}

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : null}

        <DialogFooter>
          {step === "intent" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending !== null}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <Sparkles className="size-3.5" />
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
                onClick={() => void submit()}
                disabled={pending !== null}
              >
                <Play className="size-3.5" />
                {pending === "start" ? t("starting") : t("approve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PersonPicker({
  label,
  agents,
  selected,
  onToggle,
  empty,
}: {
  label: string;
  agents: MissionAgentOption[];
  selected: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      {agents.length === 0 ? (
        <p className="text-[11px] text-zinc-500">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {agents.map((agent) => {
            const active = selected.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onToggle(agent.id)}
                className={
                  active
                    ? "rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200"
                    : "rounded-md border border-border px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                }
              >
                {agent.id}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
