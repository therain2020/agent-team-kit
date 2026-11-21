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
import type { StudioAgent } from "@/lib/pack-studio";
import { ArrowLeft, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { TokenPicker } from "./token-picker";

const ID_SLUG = /^[a-z][a-z0-9-]*$/;

export interface NewMemberValues {
  description: string;
  model: string;
  role: Exclude<StudioAgent["role"], "manager">;
  instructions: string;
  tools: string[];
  skills: string[];
}

interface MemberDraftResult {
  id: string;
  values: NewMemberValues;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

/**
 * Two-step creation for a new teammate (94 C-6b).
 *
 * First input is only the object (member id) + a one-sentence intent. The
 * compose draft fills role/model/tools/skills/instructions, everything stays
 * editable in the review step, and only the explicit create button calls the
 * existing `/agents` API — closing the dialog writes nothing.
 */
export function NewMemberDialog({
  dirName,
  tools,
  skills,
  onCreated,
}: {
  dirName: string;
  tools: Array<{ name: string; source: string }>;
  skills: string[];
  onCreated: (member: NewMemberValues & { id: string }) => void;
}) {
  const t = useTranslations("studio");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [memberId, setMemberId] = useState("");
  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<MemberDraftResult | null>(null);
  const [pending, setPending] = useState<"draft" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("intent");
    setMemberId("");
    setIntent("");
    setDraft(null);
    setError(null);
    setPending(null);
  }

  function validId(id: string): boolean {
    return ID_SLUG.test(id) && id !== "manager";
  }

  async function generate() {
    setError(null);
    const id = memberId.trim();
    if (!validId(id)) {
      setError(t("newMemberIdInvalid"));
      return;
    }
    if (!intent.trim()) {
      setError(t("agentDraftIntentRequired"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "studio.member",
          intent: intent.trim(),
          packDir: dirName,
          agentId: id,
        }),
      });
      const payload = (await response.json()) as {
        values?: NewMemberValues;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("createFailed"));
      }
      setDraft({
        id,
        values: sanitizeMember(payload.values),
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
    const id = draft.id.trim();
    if (!validId(id)) {
      setError(t("newMemberIdInvalid"));
      return;
    }
    if (!draft.values.description.trim()) {
      setError(t("newMemberDescriptionRequired"));
      return;
    }
    setError(null);
    setPending("create");
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/agents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, ...draft.values }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("createFailed"));
      }
      toast.success(t("agentCreated"));
      onCreated({ id, ...draft.values });
      setOpen(false);
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createFailed"));
    } finally {
      setPending(null);
    }
  }

  function patchValues(patch: Partial<NewMemberValues>) {
    setDraft((current) =>
      current
        ? { ...current, values: { ...current.values, ...patch } }
        : current,
    );
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
          {t("newAgent")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("newMemberTitle")}</DialogTitle>
          <DialogDescription>
            {step === "intent" ? t("newMemberHint") : t("newMemberReviewHint")}
          </DialogDescription>
        </DialogHeader>

        {step === "intent" ? (
          <div className="space-y-4">
            <label
              htmlFor="new-member-id"
              className="block space-y-1.5 text-xs font-medium text-zinc-300"
            >
              {t("newMemberIdLabel")}
              <Input
                id="new-member-id"
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
                placeholder={t("agentIdPlaceholder")}
                className="font-mono"
              />
            </label>
            <label
              htmlFor="new-member-intent"
              className="block space-y-1.5 text-xs font-medium text-zinc-300"
            >
              {t("newMemberIntentLabel")}
              <Textarea
                id="new-member-intent"
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("agentDraftPlaceholder")}
                className="min-h-20 text-sm"
              />
            </label>
            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : draft ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="violet">{draft.id}</Badge>
                <Badge variant={draft.model === "live" ? "success" : "outline"}>
                  {draft.model === "live"
                    ? t("agentDraftAi")
                    : t("agentDraftHeuristic")}
                </Badge>
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

            <div className="grid gap-3 sm:grid-cols-2">
              <label
                htmlFor="draft-member-id"
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("newMemberIdLabel")}
                <Input
                  id="draft-member-id"
                  value={draft.id}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? { ...current, id: event.target.value }
                        : current,
                    )
                  }
                  className="font-mono"
                />
              </label>
              <label
                htmlFor="draft-member-model"
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("model")}
                <Input
                  id="draft-member-model"
                  value={draft.values.model}
                  onChange={(event) =>
                    patchValues({ model: event.target.value })
                  }
                  className="font-mono"
                />
              </label>
              <label
                htmlFor="draft-member-description"
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500 sm:col-span-2"
              >
                {t("agentDescriptionLabel")}
                <Input
                  id="draft-member-description"
                  value={draft.values.description}
                  onChange={(event) =>
                    patchValues({ description: event.target.value })
                  }
                />
              </label>
              <label
                htmlFor="draft-member-role"
                className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
              >
                {t("role")}
                <select
                  id="draft-member-role"
                  value={draft.values.role}
                  onChange={(event) =>
                    patchValues({
                      role: event.target.value as NewMemberValues["role"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
                >
                  <option value="builder">{t("roleBuilder")}</option>
                  <option value="seller">{t("roleSeller")}</option>
                  <option value="specialist">{t("roleSpecialist")}</option>
                </select>
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("tools")}
                <TokenPicker
                  values={draft.values.tools}
                  options={tools.map((tool) => ({
                    value: tool.name,
                    description:
                      tool.source === "toolpack" ? "toolpack" : undefined,
                  }))}
                  onChange={(tools) => patchValues({ tools })}
                  selectLabel={t("addTool")}
                  customPlaceholder={t("customTool")}
                  addLabel={t("add")}
                  unknownLabel={t("unknownTool")}
                />
              </div>
              <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("skills")}
                <TokenPicker
                  values={draft.values.skills}
                  options={skills.map((skill) => ({ value: skill }))}
                  onChange={(next) => patchValues({ skills: next })}
                  selectLabel={t("addSkill")}
                  customPlaceholder={t("customSkill")}
                  addLabel={t("add")}
                  unknownLabel={t("unknownSkill")}
                />
              </div>
            </div>

            <label
              htmlFor="draft-member-instructions"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("instructions")}
              <Textarea
                id="draft-member-instructions"
                value={draft.values.instructions}
                onChange={(event) =>
                  patchValues({ instructions: event.target.value })
                }
                rows={6}
                className="font-mono text-[11px] leading-relaxed"
              />
            </label>

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
                  ? t("agentDraftGenerating")
                  : t("agentDraftGenerate")}
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
                  ? t("agentDraftGenerating")
                  : t("newMemberCreate")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function sanitizeMember(values: NewMemberValues): NewMemberValues {
  const role =
    values.role === "seller" || values.role === "specialist"
      ? values.role
      : "builder";
  return {
    description: values.description ?? "",
    model: values.model ?? "",
    role,
    instructions: values.instructions ?? "",
    tools: values.tools ?? [],
    skills: values.skills ?? [],
  };
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
