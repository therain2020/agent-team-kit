"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { InterestProfile } from "@kit/core";
import { ArrowLeft, RefreshCw, Save, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface Draft {
  topics: string[];
  entities: string[];
  exclusions: string[];
  thresholds: { relevance: number; novelty: number; urgency: number };
  dailyBudgetCny: number;
  rationale: string;
  model: "heuristic";
}

interface FormState {
  topics: string;
  entities: string;
  exclusions: string;
  relevance: string;
  novelty: string;
  urgency: string;
  budget: string;
  rationale: string;
}

function formFrom(profile: InterestProfile): FormState {
  return {
    topics: profile.topics.join(", "),
    entities: profile.entities.join(", "),
    exclusions: profile.exclusions.join(", "),
    relevance: String(profile.thresholds.relevance),
    novelty: String(profile.thresholds.novelty),
    urgency: String(profile.thresholds.urgency),
    budget: String(profile.dailyBudgetCny),
    rationale: profile.rationale,
  };
}

function formFromDraft(draft: Draft): FormState {
  return {
    topics: draft.topics.join(", "),
    entities: draft.entities.join(", "),
    exclusions: draft.exclusions.join(", "),
    relevance: String(draft.thresholds.relevance),
    novelty: String(draft.thresholds.novelty),
    urgency: String(draft.thresholds.urgency),
    budget: String(draft.dailyBudgetCny),
    rationale: draft.rationale,
  };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * InterestProfile editor (98 §3.5, D-64).
 *
 * One sentence of intent → labeled heuristic draft → observer review/edit with
 * a required rationale → explicit save. The draft request has no side effect;
 * saving appends a new version and audit row on the server.
 */
export function ProfileEditor({
  initialProfile,
  persisted,
}: {
  initialProfile: InterestProfile;
  persisted: boolean;
}) {
  const t = useTranslations("information");
  const router = useRouter();
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [intent, setIntent] = useState("");
  const [form, setForm] = useState<FormState>(() => formFrom(initialProfile));
  const [version, setVersion] = useState(initialProfile.version);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [model, setModel] = useState<"heuristic" | "model">("heuristic");
  const [pending, setPending] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function generate() {
    setError(null);
    if (!intent.trim()) {
      setError(t("intentRequired"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/information/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: intent.trim() }),
      });
      const payload = (await response.json()) as {
        draft?: Draft;
        model?: "heuristic" | "model";
        error?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error ?? t("draftFailed"));
      }
      setForm(formFromDraft(payload.draft));
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
    setPending("save");
    try {
      const response = await fetch("/api/information", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topics: parseList(form.topics),
          entities: parseList(form.entities),
          exclusions: parseList(form.exclusions),
          thresholds: {
            relevance: Number(form.relevance),
            novelty: Number(form.novelty),
            urgency: Number(form.urgency),
          },
          dailyBudgetCny: Number(form.budget),
          updatedBy: "human",
          rationale: form.rationale.trim(),
          expectedVersion: version,
        }),
      });
      const payload = (await response.json()) as {
        profile?: InterestProfile;
        error?: string;
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error ?? t("saveFailed"));
      }
      setVersion(payload.profile.version);
      setSavedVersion(payload.profile.version);
      toast.success(t("saved", { version: payload.profile.version }), {
        description: payload.profile.rationale,
      });
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
        <Badge variant="outline">
          {persisted ? t("versionBadge", { version }) : t("defaultProfile")}
        </Badge>
        <Badge variant={model === "model" ? "success" : "outline"}>
          {t("modelLabel", { model })}
        </Badge>
        {savedVersion !== null ? (
          <Badge variant="success">
            {t("savedBadge", { version: savedVersion })}
          </Badge>
        ) : null}
      </div>

      {step === "intent" ? (
        <>
          <label
            htmlFor="interest-intent"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("intentLabel")}
            <Textarea
              id="interest-intent"
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
                setForm(formFrom(initialProfile));
                setVersion(initialProfile.version);
                setSavedVersion(null);
                setStep("review");
              }}
              disabled={pending !== null}
            >
              {t("editCurrent")}
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
              id="interest-topics"
              label={t("topics")}
              value={form.topics}
              onChange={(value) => update("topics", value)}
              hint={t("topicsHint")}
            />
            <Field
              id="interest-entities"
              label={t("entities")}
              value={form.entities}
              onChange={(value) => update("entities", value)}
              hint={t("entitiesHint")}
            />
            <Field
              id="interest-exclusions"
              label={t("exclusions")}
              value={form.exclusions}
              onChange={(value) => update("exclusions", value)}
              hint={t("exclusionsHint")}
            />
            <Field
              id="interest-budget"
              label={t("dailyBudget")}
              value={form.budget}
              onChange={(value) => update("budget", value)}
              hint={t("dailyBudgetHint")}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              id="interest-relevance"
              label={t("relevance")}
              value={form.relevance}
              onChange={(value) => update("relevance", value)}
              hint={t("thresholdHint")}
            />
            <Field
              id="interest-novelty"
              label={t("novelty")}
              value={form.novelty}
              onChange={(value) => update("novelty", value)}
              hint={t("thresholdHint")}
            />
            <Field
              id="interest-urgency"
              label={t("urgency")}
              value={form.urgency}
              onChange={(value) => update("urgency", value)}
              hint={t("thresholdHint")}
            />
          </div>

          <label
            htmlFor="interest-rationale"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("rationale")}
            <Textarea
              id="interest-rationale"
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
