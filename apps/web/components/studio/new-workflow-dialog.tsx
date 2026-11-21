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
import { type WorkflowStageDraft, draftStageToYaml } from "@/lib/studio-drafts";
import { ArrowLeft, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { stringify } from "yaml";

const ID_SLUG = /^[a-z][a-z0-9-]*$/;

interface WorkflowDraftResult {
  values: { stages: WorkflowStageDraft[] };
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

/**
 * Two-step creation for a new workflow (94 C-9).
 *
 * First input is only the object (workflow id) + a one-sentence intent. The
 * compose draft returns a validated stage graph that stays editable in the
 * review step; the explicit create button POSTs the graph through the existing
 * workflow API, which re-validates the whole pack before writing.
 */
export function NewWorkflowDialog({
  dirName,
  agentIds,
  onCreated,
}: {
  dirName: string;
  agentIds: string[];
  onCreated: (workflow: { id: string; file: string; content: string }) => void;
}) {
  const t = useTranslations("studio");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [workflowId, setWorkflowId] = useState("");
  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<WorkflowDraftResult | null>(null);
  const [pending, setPending] = useState<"draft" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("intent");
    setWorkflowId("");
    setIntent("");
    setDraft(null);
    setError(null);
    setPending(null);
  }

  async function generate() {
    setError(null);
    const id = workflowId.trim();
    if (!ID_SLUG.test(id)) {
      setError(t("newWorkflowIdInvalid"));
      return;
    }
    if (!intent.trim()) {
      setError(t("workflowDraftIntentRequired"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "studio.workflow",
          intent: intent.trim(),
          packDir: dirName,
          workflowId: id,
        }),
      });
      const payload = (await response.json()) as {
        values?: { stages?: WorkflowStageDraft[] };
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values?.stages) {
        throw new Error(payload.error ?? t("createFailed"));
      }
      setDraft({
        values: { stages: payload.values.stages },
        rationale: payload.rationale ?? "",
        warnings: payload.warnings ?? [],
        model: payload.model === "live" ? "live" : "heuristic",
      });
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createFailed"));
    } finally {
      setPending(null);
    }
  }

  async function create() {
    if (!draft) {
      return;
    }
    const id = workflowId.trim();
    if (!ID_SLUG.test(id)) {
      setError(t("newWorkflowIdInvalid"));
      return;
    }
    if (draft.values.stages.length === 0) {
      setError(t("newWorkflowStagesRequired"));
      return;
    }
    setError(null);
    setPending("create");
    try {
      const content = stringify({
        id,
        version: "1.0",
        trigger: { event: "task.received" },
        stages: draft.values.stages.map(draftStageToYaml),
        delivery: { channel: "local_file" },
      });
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, content }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("createFailed"));
      }
      toast.success(t("workflowCreated"));
      onCreated({ id, file: `workflows/${id}.yaml`, content });
      setOpen(false);
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createFailed"));
    } finally {
      setPending(null);
    }
  }

  function patchStage(index: number, patch: Partial<WorkflowStageDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            values: {
              stages: current.values.stages.map((stage, stageIndex) =>
                stageIndex === index ? { ...stage, ...patch } : stage,
              ),
            },
          }
        : current,
    );
  }

  function removeStage(index: number) {
    setDraft((current) =>
      current
        ? {
            ...current,
            values: {
              stages: current.values.stages.filter(
                (_, stageIndex) => stageIndex !== index,
              ),
            },
          }
        : current,
    );
  }

  function addStage() {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const index = current.values.stages.length + 1;
      const previous = current.values.stages.at(-1);
      const firstAgent = agentIds[0];
      const id = `stage-${index}`;
      return {
        ...current,
        values: {
          stages: [
            ...current.values.stages,
            {
              id,
              type: "agent",
              ...(firstAgent ? { agent: firstAgent } : {}),
              inputs: previous ? previous.outputs : ["task"],
              outputs: [`${id}_output`],
              depends: previous ? [previous.id] : [],
            },
          ],
        },
      };
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setStep("intent");
          setDraft(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          <Plus className="size-3.5" />
          {t("workflowNew")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("newWorkflowTitle")}</DialogTitle>
          <DialogDescription>
            {step === "intent"
              ? t("newWorkflowHint")
              : t("newWorkflowReviewHint")}
          </DialogDescription>
        </DialogHeader>

        {step === "intent" ? (
          <div className="space-y-4">
            <label
              htmlFor="new-workflow-id"
              className="block space-y-1.5 text-xs font-medium text-zinc-300"
            >
              {t("newWorkflowIdLabel")}
              <Input
                id="new-workflow-id"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
                placeholder={t("workflowId")}
                className="font-mono"
              />
            </label>
            <label
              htmlFor="new-workflow-intent"
              className="block space-y-1.5 text-xs font-medium text-zinc-300"
            >
              {t("newWorkflowIntentLabel")}
              <Textarea
                id="new-workflow-intent"
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("workflowDraftPlaceholder")}
                className="min-h-20 text-sm"
              />
            </label>
            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : draft ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="violet">{workflowId.trim()}</Badge>
                <Badge variant={draft.model === "live" ? "success" : "outline"}>
                  {draft.model === "live"
                    ? t("agentDraftAi")
                    : t("agentDraftHeuristic")}
                </Badge>
                <span className="text-[10px] text-zinc-500">
                  {t("workflowDraftStages", {
                    count: draft.values.stages.length,
                  })}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-200">{intent}</p>
              {draft.rationale ? (
                <p className="mt-1 text-[11px] text-zinc-400">
                  {draft.rationale}
                </p>
              ) : null}
            </div>

            {draft.warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {draft.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-2">
              {draft.values.stages.map((stage, index) => (
                <div
                  key={`${stage.id}-${index}`}
                  className="space-y-2 rounded-md border border-border p-2"
                >
                  <div className="grid gap-2 sm:grid-cols-[8rem_7rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input
                      value={stage.id}
                      onChange={(event) =>
                        patchStage(index, { id: event.target.value })
                      }
                      aria-label={t("draftStageId")}
                      className="h-8 font-mono text-[11px]"
                    />
                    <select
                      value={stage.type}
                      onChange={(event) => {
                        const type = event.target
                          .value as WorkflowStageDraft["type"];
                        patchStage(
                          index,
                          type === "coder"
                            ? { type, agent: undefined }
                            : { type, coder: undefined },
                        );
                      }}
                      aria-label={t("draftStageType")}
                      className="h-8 rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] text-zinc-200"
                    >
                      <option value="agent">agent</option>
                      <option value="coder">coder</option>
                      <option value="workflow">workflow</option>
                    </select>
                    <Input
                      value={stage.agent ?? stage.coder ?? ""}
                      onChange={(event) =>
                        stage.type === "coder"
                          ? patchStage(index, {
                              coder: event.target.value || undefined,
                            })
                          : patchStage(index, {
                              agent: event.target.value || undefined,
                            })
                      }
                      aria-label={t("draftStageAgent")}
                      placeholder={t("draftStageAgent")}
                      className="h-8 font-mono text-[11px]"
                    />
                    <Input
                      value={stage.goal ?? ""}
                      onChange={(event) =>
                        patchStage(index, { goal: event.target.value })
                      }
                      aria-label={t("draftStageGoal")}
                      placeholder={t("draftStageGoal")}
                      className="h-8 text-[11px]"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeStage(index)}
                      disabled={draft.values.stages.length <= 1}
                      aria-label={t("removeStage")}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Input
                      value={stage.inputs.join(", ")}
                      onChange={(event) =>
                        patchStage(index, {
                          inputs: splitList(event.target.value),
                        })
                      }
                      aria-label={t("draftStageInputs")}
                      placeholder={t("draftStageInputs")}
                      className="h-8 font-mono text-[11px]"
                    />
                    <Input
                      value={stage.outputs.join(", ")}
                      onChange={(event) =>
                        patchStage(index, {
                          outputs: splitList(event.target.value),
                        })
                      }
                      aria-label={t("draftStageOutputs")}
                      placeholder={t("draftStageOutputs")}
                      className="h-8 font-mono text-[11px]"
                    />
                    <Input
                      value={stage.depends.join(", ")}
                      onChange={(event) =>
                        patchStage(index, {
                          depends: splitList(event.target.value),
                        })
                      }
                      aria-label={t("draftStageDepends")}
                      placeholder={t("draftStageDepends")}
                      className="h-8 font-mono text-[11px]"
                    />
                    <Input
                      value={stage.gate ?? ""}
                      onChange={(event) =>
                        patchStage(index, {
                          gate: event.target.value || undefined,
                        })
                      }
                      aria-label={t("draftStageGate")}
                      placeholder={t("draftStageGate")}
                      className="h-8 font-mono text-[11px]"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                    <input
                      type="checkbox"
                      checked={Boolean(stage.approval)}
                      onChange={(event) =>
                        patchStage(index, {
                          approval: event.target.checked
                            ? {
                                mode: "required",
                                position: "before",
                                riskClass: "high",
                                ttl: "72h",
                              }
                            : undefined,
                        })
                      }
                      className="size-3.5 accent-emerald-500"
                    />
                    {t("draftStageApproval")}
                  </label>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={addStage}>
                <Plus className="size-3.5" />
                {t("addStage")}
              </Button>
            </div>

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : null}

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
                <Sparkles className="size-3.5" />
                {pending === "draft"
                  ? t("workflowDraftGenerating")
                  : t("workflowDraftGenerate")}
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
                {t("draftBack")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <RefreshCw className="size-3.5" />
                {t("draftRegenerate")}
              </Button>
              <Button
                size="sm"
                onClick={() => void create()}
                disabled={pending !== null}
              >
                {pending === "create"
                  ? t("workflowDraftGenerating")
                  : t("newWorkflowCreate")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
