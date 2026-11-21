"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ReactionRule } from "@kit/core";
import { ArrowLeft, RefreshCw, Save, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface Draft {
  name: string;
  match: {
    eventType: string;
    topics: string[];
    entities: string[];
    minSignals: { relevance?: number; novelty?: number; urgency?: number };
  };
  target: {
    packDir: string;
    jobKind: "packRun" | "iteration";
    workflow?: string;
    goal?: string;
  };
  missionTemplate: string;
  runMode: "DRY_RUN" | "LIVE";
  budget?: { dailyRuns?: number; dailyCostCny?: number };
  priority: number;
  rationale: string;
  model: "heuristic";
}

interface FormState {
  name: string;
  eventType: string;
  topics: string;
  entities: string;
  relevance: string;
  novelty: string;
  urgency: string;
  packDir: string;
  workflow: string;
  goal: string;
  mission: string;
  runMode: "DRY_RUN" | "LIVE";
  priority: string;
  dailyRuns: string;
  dailyCost: string;
  enabled: boolean;
  rationale: string;
}

const EMPTY: FormState = {
  name: "",
  eventType: "information.*",
  topics: "",
  entities: "",
  relevance: "0.5",
  novelty: "",
  urgency: "",
  packDir: "",
  workflow: "",
  goal: "",
  mission: "React to {title} ({eventId}) from {sourceId}",
  runMode: "DRY_RUN",
  priority: "0",
  dailyRuns: "3",
  dailyCost: "",
  enabled: true,
  rationale: "",
};

function formFromRule(rule: ReactionRule): FormState {
  return {
    name: rule.name,
    eventType: rule.match.eventType,
    topics: rule.match.topics.join(", "),
    entities: rule.match.entities.join(", "),
    relevance: stringOrEmpty(rule.match.minSignals.relevance),
    novelty: stringOrEmpty(rule.match.minSignals.novelty),
    urgency: stringOrEmpty(rule.match.minSignals.urgency),
    packDir: rule.target.packDir,
    workflow: rule.target.workflow ?? "",
    goal: rule.target.goal ?? "",
    mission: rule.missionTemplate ?? "",
    runMode: rule.runMode,
    priority: String(rule.priority),
    dailyRuns: stringOrEmpty(rule.budget?.dailyRuns),
    dailyCost: stringOrEmpty(rule.budget?.dailyCostCny),
    enabled: rule.enabled,
    rationale: rule.rationale,
  };
}

function formFromDraft(draft: Draft): FormState {
  return {
    name: draft.name,
    eventType: draft.match.eventType,
    topics: draft.match.topics.join(", "),
    entities: draft.match.entities.join(", "),
    relevance: stringOrEmpty(draft.match.minSignals.relevance),
    novelty: stringOrEmpty(draft.match.minSignals.novelty),
    urgency: stringOrEmpty(draft.match.minSignals.urgency),
    packDir: draft.target.packDir,
    workflow: draft.target.workflow ?? "",
    goal: draft.target.goal ?? "",
    mission: draft.missionTemplate,
    runMode: draft.runMode,
    priority: String(draft.priority),
    dailyRuns: stringOrEmpty(draft.budget?.dailyRuns),
    dailyCost: stringOrEmpty(draft.budget?.dailyCostCny),
    enabled: true,
    rationale: draft.rationale,
  };
}

function stringOrEmpty(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * ReactionRule editor (98 §3.5, D-64).
 *
 * Intent → labeled heuristic draft → observer review/edit with a required
 * rationale → explicit save. The draft request has no side effects; saving
 * appends a new version and audit row. A model can only propose here.
 */
export function ReactionRuleEditor({ rules }: { rules: ReactionRule[] }) {
  const t = useTranslations("reactions");
  const router = useRouter();
  const [selectedId, setSelectedId] = useState("");
  const selected = rules.find((rule) => rule.ruleId === selectedId) ?? null;
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [intent, setIntent] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [version, setVersion] = useState<number | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [model, setModel] = useState<"heuristic" | "model">("heuristic");
  const [pending, setPending] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectRule(ruleId: string) {
    setSelectedId(ruleId);
    const rule = rules.find((item) => item.ruleId === ruleId);
    if (rule) {
      setForm(formFromRule(rule));
      setVersion(rule.version);
      setSavedVersion(null);
      setStep("review");
    } else {
      setForm(EMPTY);
      setVersion(null);
      setStep("intent");
    }
  }

  async function generate() {
    setError(null);
    if (!intent.trim()) {
      setError(t("intentRequired"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/reactions/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: intent.trim(),
          ...(selectedId ? { ruleId: selectedId } : {}),
        }),
      });
      const payload = (await response.json()) as {
        draft?: Draft;
        model?: "heuristic" | "model";
        error?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error ?? t("draftFailed"));
      }
      setForm((current) => ({
        ...formFromDraft(payload.draft as Draft),
        enabled: current.enabled,
      }));
      setModel(payload.model === "model" ? "model" : "heuristic");
      setSavedVersion(null);
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("draftFailed"));
    } finally {
      setPending(null);
    }
  }

  async function save() {
    setError(null);
    if (!form.rationale.trim()) {
      setError(t("rationaleRequired"));
      return;
    }
    if (!form.name.trim()) {
      setError(t("nameRequired"));
      return;
    }
    if (!form.packDir.trim()) {
      setError(t("packRequired"));
      return;
    }
    if (!form.workflow.trim() && !form.goal.trim()) {
      setError(t("targetRequired"));
      return;
    }
    const minSignals = {
      ...(form.relevance.trim() ? { relevance: Number(form.relevance) } : {}),
      ...(form.novelty.trim() ? { novelty: Number(form.novelty) } : {}),
      ...(form.urgency.trim() ? { urgency: Number(form.urgency) } : {}),
    };
    const budget = {
      ...(form.dailyRuns.trim() ? { dailyRuns: Number(form.dailyRuns) } : {}),
      ...(form.dailyCost.trim()
        ? { dailyCostCny: Number(form.dailyCost) }
        : {}),
    };
    setPending("save");
    try {
      const response = await fetch("/api/reactions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(selectedId ? { ruleId: selectedId } : {}),
          name: form.name.trim(),
          enabled: form.enabled,
          match: {
            eventType: form.eventType.trim() || "information.*",
            topics: parseList(form.topics),
            entities: parseList(form.entities),
            minSignals,
          },
          target: {
            packDir: form.packDir.trim(),
            jobKind: form.workflow.trim() ? "packRun" : "iteration",
            ...(form.workflow.trim() ? { workflow: form.workflow.trim() } : {}),
            ...(form.goal.trim() ? { goal: form.goal.trim() } : {}),
          },
          ...(form.mission.trim()
            ? { missionTemplate: form.mission.trim() }
            : {}),
          runMode: form.runMode,
          ...(Object.keys(budget).length > 0 ? { budget } : {}),
          priority: Number(form.priority) || 0,
          source: "human",
          rationale: form.rationale.trim(),
          ...(version !== null ? { expectedVersion: version } : {}),
        }),
      });
      const payload = (await response.json()) as {
        rule?: ReactionRule;
        error?: string;
      };
      if (!response.ok || !payload.rule) {
        throw new Error(payload.error ?? t("saveFailed"));
      }
      toast.success(
        t("saved", {
          version: payload.rule.version,
          ruleId: payload.rule.ruleId,
        }),
        { description: payload.rule.rationale },
      );
      setSelectedId(payload.rule.ruleId);
      setVersion(payload.rule.version);
      setSavedVersion(payload.rule.version);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="violet">{t("editorTitle")}</Badge>
        {version !== null ? (
          <Badge variant="outline">{t("versionBadge", { version })}</Badge>
        ) : null}
        <Badge variant={model === "model" ? "success" : "outline"}>
          {t("modelLabel", { model })}
        </Badge>
        {savedVersion !== null ? (
          <Badge variant="success">
            {t("savedBadge", { version: savedVersion })}
          </Badge>
        ) : null}
      </div>

      <label
        htmlFor="reaction-select"
        className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
      >
        {t("selectRule")}
        <select
          id="reaction-select"
          value={selectedId}
          onChange={(event) => selectRule(event.target.value)}
          className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 text-[11px] text-zinc-200"
        >
          <option value="">{t("newRule")}</option>
          {rules.map((rule) => (
            <option key={rule.ruleId} value={rule.ruleId}>
              {rule.name} · {rule.ruleId}
            </option>
          ))}
        </select>
      </label>

      {step === "intent" ? (
        <>
          <label
            htmlFor="reaction-intent"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("intentLabel")}
            <Textarea
              id="reaction-intent"
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              placeholder={t("intentPlaceholder")}
              className="min-h-20 text-sm"
            />
          </label>
          <p className="text-[10px] text-zinc-600">{t("intentHint")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void generate()}
              disabled={pending !== null}
            >
              <Sparkles className="size-3.5" />
              {pending === "draft" ? t("drafting") : t("draftButton")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelectedId("");
                setForm(EMPTY);
                setVersion(null);
                setSavedVersion(null);
                setStep("review");
              }}
              disabled={pending !== null}
            >
              {t("startBlank")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="rounded border border-border bg-zinc-950/60 px-2 py-1.5 text-[11px] text-zinc-400">
            {t("draftSummary")} {form.rationale}
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <Field
              id="reaction-name"
              label={t("name")}
              value={form.name}
              onChange={(value) => update("name", value)}
              hint={t("nameHint")}
            />
            <Field
              id="reaction-event-type"
              label={t("eventType")}
              value={form.eventType}
              onChange={(value) => update("eventType", value)}
              hint={t("eventTypeHint")}
            />
            <Field
              id="reaction-topics"
              label={t("topics")}
              value={form.topics}
              onChange={(value) => update("topics", value)}
              hint={t("topicsHint")}
            />
            <Field
              id="reaction-entities"
              label={t("entities")}
              value={form.entities}
              onChange={(value) => update("entities", value)}
              hint={t("entitiesHint")}
            />
            <Field
              id="reaction-pack"
              label={t("packDir")}
              value={form.packDir}
              onChange={(value) => update("packDir", value)}
              hint={t("packDirHint")}
            />
            <Field
              id="reaction-workflow"
              label={t("workflow")}
              value={form.workflow}
              onChange={(value) => update("workflow", value)}
              hint={t("workflowHint")}
            />
            <Field
              id="reaction-goal"
              label={t("goal")}
              value={form.goal}
              onChange={(value) => update("goal", value)}
              hint={t("goalHint")}
            />
            <Field
              id="reaction-mission"
              label={t("mission")}
              value={form.mission}
              onChange={(value) => update("mission", value)}
              hint={t("missionHint")}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              id="reaction-relevance"
              label={t("relevance")}
              value={form.relevance}
              onChange={(value) => update("relevance", value)}
              hint={t("thresholdHint")}
            />
            <Field
              id="reaction-novelty"
              label={t("novelty")}
              value={form.novelty}
              onChange={(value) => update("novelty", value)}
              hint={t("thresholdHint")}
            />
            <Field
              id="reaction-urgency"
              label={t("urgency")}
              value={form.urgency}
              onChange={(value) => update("urgency", value)}
              hint={t("thresholdHint")}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              id="reaction-priority"
              label={t("priority")}
              value={form.priority}
              onChange={(value) => update("priority", value)}
              hint={t("priorityHint")}
            />
            <Field
              id="reaction-daily-runs"
              label={t("dailyRuns")}
              value={form.dailyRuns}
              onChange={(value) => update("dailyRuns", value)}
              hint={t("dailyRunsHint")}
            />
            <Field
              id="reaction-daily-cost"
              label={t("dailyCost")}
              value={form.dailyCost}
              onChange={(value) => update("dailyCost", value)}
              hint={t("dailyCostHint")}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                checked={form.runMode === "LIVE"}
                onChange={(event) =>
                  update("runMode", event.target.checked ? "LIVE" : "DRY_RUN")
                }
              />
              {t("runLive")}
            </label>
            <label className="flex items-center gap-2 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update("enabled", event.target.checked)}
              />
              {t("enabledLabel")}
            </label>
          </div>

          <label
            htmlFor="reaction-rationale"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("rationale")}
            <Textarea
              id="reaction-rationale"
              value={form.rationale}
              onChange={(event) => update("rationale", event.target.value)}
              rows={3}
              className="text-[11px]"
            />
          </label>
          <p className="text-[10px] text-zinc-600">{t("rationaleHint")}</p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
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
              disabled={pending !== null || !intent.trim()}
            >
              <RefreshCw className="size-3.5" />
              {t("regenerate")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={pending !== null}
            >
              <Save className="size-3.5" />
              {pending === "save" ? t("saving") : t("save")}
            </Button>
          </div>
          <p className="text-[10px] text-zinc-600">{t("saveHint")}</p>
        </>
      )}

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
    >
      {label}
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-[11px]"
      />
      {hint ? (
        <span className="block text-[9px] normal-case tracking-normal text-zinc-600">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
