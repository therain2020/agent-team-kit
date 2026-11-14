"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StudioAgent, StudioStage } from "@/lib/pack-studio";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

interface StageDraft {
  type: StudioStage["type"];
  agent: string;
  coder: string;
  goal: string;
  acceptance: string;
  inputs: string;
  outputs: string;
  timeout: string;
  gate: string;
  depends: string[];
  includeInitialInput: boolean;
  revisionAgent: string;
}

export function StageFields({
  dirName,
  file,
  stages,
  agents,
  onSaved,
}: {
  dirName: string;
  file: string;
  stages: StudioStage[];
  agents: StudioAgent[];
  onSaved: () => void;
}) {
  const t = useTranslations("studio");
  const [drafts, setDrafts] = useState<Record<string, StageDraft>>(() =>
    buildDrafts(stages),
  );
  const [busy, setBusy] = useState<string | null>(null);

  function patch(stageId: string, update: Partial<StageDraft>) {
    setDrafts((current) => {
      const draft = current[stageId];
      if (!draft) {
        return current;
      }
      return { ...current, [stageId]: { ...draft, ...update } };
    });
  }

  async function save(stageId: string) {
    const draft = drafts[stageId];
    if (!draft) {
      return;
    }
    setBusy(stageId);
    try {
      const depends = draft.depends;
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/stage`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            file,
            stageId,
            fields: {
              type: draft.type,
              agent: draft.type === "agent" ? draft.agent || null : null,
              coder: draft.type === "coder" ? draft.coder || null : null,
              goal: draft.goal,
              acceptance: draft.acceptance,
              inputs: splitList(draft.inputs),
              outputs: splitList(draft.outputs),
              timeout: draft.timeout,
              gate: draft.gate,
              revisionAgent: draft.revisionAgent,
              includeInitialInput: draft.includeInitialInput,
              inputsFrom: depends.length > 0 ? depends : null,
              ...(depends.length === 0 ? { inputFrom: null } : {}),
            },
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "save failed");
      }
      toast.success(t("stage.saved"));
      onSaved();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      toast.error(text);
    } finally {
      setBusy(null);
    }
  }

  const agentOptions = agents
    .filter((agent) => !agent.isManager)
    .map((agent) => agent.id);
  const manager = agents.find((agent) => agent.isManager);
  if (manager) {
    agentOptions.push(manager.id);
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-zinc-400">{t("stage.title")}</p>
      {stages.map((stage) => {
        const draft = drafts[stage.id];
        if (!draft) {
          return null;
        }
        const otherStages = stages
          .filter((item) => item.id !== stage.id)
          .map((item) => item.id);
        return (
          <div
            key={stage.id}
            className="rounded-lg border border-border bg-zinc-950/40 p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-zinc-200">
                {stage.id}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => save(stage.id)}
                disabled={busy === stage.id}
              >
                <Save className="size-3" />
                {t("save")}
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("stage.type")}
                <select
                  value={draft.type}
                  onChange={(event) =>
                    patch(stage.id, {
                      type: event.target.value as StudioStage["type"],
                    })
                  }
                  className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 text-[11px] text-zinc-200"
                >
                  <option value="agent">{t("stage.typeAgent")}</option>
                  <option value="coder">{t("stage.typeCoder")}</option>
                  <option value="workflow">{t("stage.typeWorkflow")}</option>
                </select>
              </label>
              {draft.type === "agent" ? (
                <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {t("stage.agent")}
                  <select
                    value={draft.agent}
                    onChange={(event) =>
                      patch(stage.id, { agent: event.target.value })
                    }
                    className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200"
                  >
                    <option value="">—</option>
                    {agentOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : draft.type === "coder" ? (
                <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {t("stage.coder")}
                  <select
                    value={draft.coder}
                    onChange={(event) =>
                      patch(stage.id, { coder: event.target.value })
                    }
                    className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200"
                  >
                    <option value="">—</option>
                    {["dsh", "codex", "opencode", "command"].map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label
                htmlFor={`${stage.id}-inputs`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.inputs")}
                <Input
                  id={`${stage.id}-inputs`}
                  value={draft.inputs}
                  onChange={(event) =>
                    patch(stage.id, { inputs: event.target.value })
                  }
                  className="h-8 font-mono text-[11px]"
                />
              </label>
              <label
                htmlFor={`${stage.id}-outputs`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.outputs")}
                <Input
                  id={`${stage.id}-outputs`}
                  value={draft.outputs}
                  onChange={(event) =>
                    patch(stage.id, { outputs: event.target.value })
                  }
                  className="h-8 font-mono text-[11px]"
                />
              </label>
              <label
                htmlFor={`${stage.id}-timeout`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.timeout")}
                <Input
                  id={`${stage.id}-timeout`}
                  value={draft.timeout}
                  onChange={(event) =>
                    patch(stage.id, { timeout: event.target.value })
                  }
                  placeholder="15m"
                  className="h-8 font-mono text-[11px]"
                />
              </label>
              <label
                htmlFor={`${stage.id}-gate`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.gate")}
                <Input
                  id={`${stage.id}-gate`}
                  value={draft.gate}
                  onChange={(event) =>
                    patch(stage.id, { gate: event.target.value })
                  }
                  placeholder="evals/rubric.yaml"
                  className="h-8 font-mono text-[11px]"
                />
              </label>
              <label
                htmlFor={`${stage.id}-goal`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.goal")}
                <Input
                  id={`${stage.id}-goal`}
                  value={draft.goal}
                  onChange={(event) =>
                    patch(stage.id, { goal: event.target.value })
                  }
                  className="h-8 text-[11px]"
                />
              </label>
              <label
                htmlFor={`${stage.id}-revision`}
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("stage.revisionAgent")}
                <Input
                  id={`${stage.id}-revision`}
                  value={draft.revisionAgent}
                  onChange={(event) =>
                    patch(stage.id, { revisionAgent: event.target.value })
                  }
                  className="h-8 font-mono text-[11px]"
                />
              </label>
            </div>
            <div className="mt-2">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("stage.dependsOn")}
              </p>
              <div className="flex flex-wrap gap-2">
                {otherStages.map((id) => (
                  <label
                    key={id}
                    className="inline-flex items-center gap-1 text-[11px] text-zinc-400"
                  >
                    <input
                      type="checkbox"
                      checked={draft.depends.includes(id)}
                      onChange={(event) =>
                        patch(stage.id, {
                          depends: event.target.checked
                            ? [...draft.depends, id]
                            : draft.depends.filter((item) => item !== id),
                        })
                      }
                    />
                    <span className="font-mono">{id}</span>
                  </label>
                ))}
                {otherStages.length === 0 ? (
                  <span className="text-[10px] text-zinc-600">
                    {t("stage.noDepends")}
                  </span>
                ) : null}
              </div>
              <label className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={draft.includeInitialInput}
                  onChange={(event) =>
                    patch(stage.id, {
                      includeInitialInput: event.target.checked,
                    })
                  }
                />
                {t("stage.includeInitialInput")}
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function buildDrafts(stages: StudioStage[]): Record<string, StageDraft> {
  const drafts: Record<string, StageDraft> = {};
  for (const stage of stages) {
    drafts[stage.id] = {
      type: stage.type,
      agent: stage.agent ?? "",
      coder: stage.coder ?? "",
      goal: stage.goal ?? "",
      acceptance: stage.acceptance ?? "",
      inputs: stage.inputs.join(", "),
      outputs: stage.outputs.join(", "),
      timeout: stage.timeout ?? "",
      gate: stage.gate ?? "",
      depends: stage.inputsFrom ?? (stage.inputFrom ? [stage.inputFrom] : []),
      includeInitialInput: stage.includeInitialInput ?? false,
      revisionAgent: stage.revisionAgent ?? "",
    };
  }
  return drafts;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
