"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bot,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Role = "builder" | "seller" | "specialist";

interface DraftAgent {
  id: string;
  description: string;
  role: Role;
  model: string;
  instructions: string;
}

interface PackDraftValues {
  dirName: string;
  name: string;
  description: string;
  template: string;
  manager: { model: string; instructions: string };
  agents: DraftAgent[];
}

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  agents: Array<{
    id: string;
    description: string;
    model: string;
    role: string;
  }>;
}

const MAX_AGENTS = 12;

export function NewPackWizard() {
  const t = useTranslations("newPack");
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  // Empty string means "let the AI choose a template".
  const [templateChoice, setTemplateChoice] = useState("");
  const [intent, setIntent] = useState("");
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [draft, setDraft] = useState<PackDraftValues | null>(null);
  const [rationale, setRationale] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [pending, setPending] = useState<"draft" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then((response) => response.json())
      .then((payload: { templates?: TemplateSummary[] }) => {
        if (!cancelled) {
          setTemplates(payload.templates ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t("templatesFailed"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function generate() {
    setError(null);
    if (!intent.trim()) {
      setError(t("intentRequired"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pack",
          intent,
          ...(templateChoice ? { templateId: templateChoice } : {}),
        }),
      });
      const payload = (await response.json()) as {
        values?: PackDraftValues;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("failed"));
      }
      setDraft(sanitizeDraft(payload.values));
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

  async function create() {
    if (!draft) {
      return;
    }
    setError(null);
    setPending("create");
    try {
      const response = await fetch("/api/packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dirName: draft.dirName,
          name: draft.name,
          description: draft.description,
          template: draft.template,
          managerModel: draft.manager.model,
          managerInstructions: draft.manager.instructions,
          agents: draft.agents,
        }),
      });
      const payload = (await response.json()) as {
        dirName?: string;
        error?: string;
      };
      if (!response.ok || !payload.dirName) {
        throw new Error(payload.error ?? t("createFailed"));
      }
      toast.success(t("created"));
      router.push(`/packs/${encodeURIComponent(payload.dirName)}/studio`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("createFailed"));
    } finally {
      setPending(null);
    }
  }

  function patchDraft(patch: Partial<PackDraftValues>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function patchManager(patch: Partial<PackDraftValues["manager"]>) {
    setDraft((current) =>
      current
        ? { ...current, manager: { ...current.manager, ...patch } }
        : current,
    );
  }

  function patchAgent(index: number, patch: Partial<DraftAgent>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            agents: current.agents.map((agent, agentIndex) =>
              agentIndex === index ? { ...agent, ...patch } : agent,
            ),
          }
        : current,
    );
  }

  function addAgent() {
    setDraft((current) => {
      if (!current || current.agents.length >= MAX_AGENTS) {
        return current;
      }
      const index = current.agents.length + 1;
      return {
        ...current,
        agents: [
          ...current.agents,
          {
            id: `worker-${index}`,
            description: "Team member",
            role: "builder",
            model: current.manager.model,
            instructions: `You are worker-${index}. Complete the assigned stage and return a concise, verifiable result.`,
          },
        ],
      };
    });
  }

  function removeAgent(index: number) {
    setDraft((current) =>
      current && current.agents.length > 1
        ? {
            ...current,
            agents: current.agents.filter(
              (_, agentIndex) => agentIndex !== index,
            ),
          }
        : current,
    );
  }

  if (step === "intent" || !draft) {
    return (
      <div className="space-y-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Users className="size-4 text-emerald-400" />
            {t("objectTitle")}
          </h2>
          <p className="mb-3 text-[11px] text-zinc-500">{t("objectHint")}</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <button
              type="button"
              onClick={() => setTemplateChoice("")}
              className={cn(
                "rounded-lg border border-border p-3 text-left transition-colors hover:border-zinc-600",
                templateChoice === "" &&
                  "border-emerald-500/50 bg-emerald-500/5",
              )}
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                <Sparkles className="size-3.5 text-emerald-400" />
                {t("aiPick")}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                {t("aiPickHint")}
              </p>
            </button>
            {templates.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTemplateChoice(item.id)}
                className={cn(
                  "rounded-lg border border-border p-3 text-left transition-colors hover:border-zinc-600",
                  templateChoice === item.id &&
                    "border-emerald-500/50 bg-emerald-500/5",
                )}
              >
                <p className="text-xs font-medium text-zinc-200">{item.name}</p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                  {item.description}
                </p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <label
            htmlFor="new-pack-intent"
            className="mb-1.5 block text-sm font-medium text-zinc-200"
          >
            {t("intentLabel")}
          </label>
          <Textarea
            id="new-pack-intent"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder={t("intentPlaceholder")}
            className="min-h-20 text-sm"
          />
          <p className="mt-2 text-[10px] text-zinc-500">{t("intentHint")}</p>
        </section>

        {error ? <ErrorLine message={error} /> : null}

        <div className="flex justify-end">
          <Button onClick={() => void generate()} disabled={pending !== null}>
            <Sparkles className="size-3.5" />
            {pending === "draft" ? t("generating") : t("generate")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
          <Badge variant="violet">{draft.template}</Badge>
          <Badge variant={model === "live" ? "success" : "outline"}>
            {model === "live" ? t("proposed") : t("heuristic")}
          </Badge>
          <Badge variant="outline">
            {t("agentCount", { count: draft.agents.length })}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-zinc-200">{intent}</p>
        {rationale ? (
          <p className="mt-1 text-[11px] text-zinc-400">{rationale}</p>
        ) : null}
      </section>

      {warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
          {warnings.map((warning) => (
            <li key={warning}>· {warning}</li>
          ))}
        </ul>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Bot className="size-4 text-violet-400" />
          {t("identity")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label
            htmlFor="draft-team-name"
            className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("teamName")}
            <Input
              id="draft-team-name"
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>
          <label
            htmlFor="draft-team-dir"
            className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("directory")}
            <Input
              id="draft-team-dir"
              value={draft.dirName}
              onChange={(event) => patchDraft({ dirName: event.target.value })}
              className="font-mono"
            />
          </label>
          <label
            htmlFor="draft-team-description"
            className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500 sm:col-span-2"
          >
            {t("descriptionLabel")}
            <Input
              id="draft-team-description"
              value={draft.description}
              onChange={(event) =>
                patchDraft({ description: event.target.value })
              }
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">
          {t("manager")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <label
            htmlFor="draft-manager-model"
            className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("model")}
            <Input
              id="draft-manager-model"
              value={draft.manager.model}
              onChange={(event) => patchManager({ model: event.target.value })}
              className="font-mono"
            />
          </label>
          <label
            htmlFor="draft-manager-instructions"
            className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("instructions")}
            <Textarea
              id="draft-manager-instructions"
              value={draft.manager.instructions}
              onChange={(event) =>
                patchManager({ instructions: event.target.value })
              }
              rows={4}
              placeholder={t("managerPlaceholder")}
              className="text-[11px] leading-relaxed"
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Users className="size-4 text-sky-400" />
            {t("employees")}
            <span className="text-[10px] font-normal text-zinc-500">
              {t("maxAgents", { count: MAX_AGENTS })}
            </span>
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={addAgent}
            disabled={draft.agents.length >= MAX_AGENTS}
          >
            <Plus className="size-3.5" />
            {t("addEmployee")}
          </Button>
        </div>
        <div className="space-y-3">
          {draft.agents.map((agent, index) => (
            <div
              key={`${agent.id}-${index}`}
              className="space-y-2 rounded-lg border border-border p-2"
            >
              <div className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_7rem_8rem_auto]">
                <Input
                  value={agent.id}
                  onChange={(event) =>
                    patchAgent(index, { id: event.target.value })
                  }
                  aria-label={t("agentId")}
                  className="h-8 font-mono text-[11px]"
                />
                <Input
                  value={agent.description}
                  onChange={(event) =>
                    patchAgent(index, { description: event.target.value })
                  }
                  aria-label={t("employeeDescription")}
                  className="h-8 text-[11px]"
                />
                <select
                  value={agent.role}
                  onChange={(event) =>
                    patchAgent(index, { role: event.target.value as Role })
                  }
                  aria-label={t("role")}
                  className="h-8 rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] text-zinc-200"
                >
                  <option value="builder">{t("roleBuilder")}</option>
                  <option value="seller">{t("roleSeller")}</option>
                  <option value="specialist">{t("roleSpecialist")}</option>
                </select>
                <Input
                  value={agent.model}
                  onChange={(event) =>
                    patchAgent(index, { model: event.target.value })
                  }
                  aria-label={t("model")}
                  className="h-8 font-mono text-[11px]"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={draft.agents.length <= 1}
                  onClick={() => removeAgent(index)}
                  aria-label={t("removeEmployee")}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Textarea
                value={agent.instructions}
                onChange={(event) =>
                  patchAgent(index, { instructions: event.target.value })
                }
                aria-label={t("instructions")}
                rows={2}
                className="text-[11px] leading-relaxed"
              />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Rocket className="size-4 text-amber-300" />
          {t("whatYouGet")}
        </h2>
        <ul className="space-y-1 text-[11px] text-zinc-400">
          <li>• {t("getFiles")}</li>
          <li>• {t("getApproval")}</li>
          <li>• {t("getAutopilot")}</li>
          <li>• {t("getStudio")}</li>
        </ul>
        <p className="mt-2 text-[10px] text-zinc-600">{t("footer")}</p>
      </section>

      {error ? <ErrorLine message={error} /> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
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
          variant="outline"
          onClick={() => void generate()}
          disabled={pending !== null}
        >
          <RefreshCw className="size-3.5" />
          {t("regenerate")}
        </Button>
        <Button
          onClick={() => void create()}
          disabled={
            pending !== null ||
            !draft.template ||
            !draft.name.trim() ||
            !draft.dirName.trim()
          }
        >
          {pending === "create" ? t("creating") : t("create")}
        </Button>
      </div>
    </div>
  );
}

function sanitizeDraft(values: PackDraftValues): PackDraftValues {
  return {
    dirName: values.dirName,
    name: values.name,
    description: values.description,
    template: values.template,
    manager: {
      model: values.manager?.model ?? "",
      instructions: values.manager?.instructions ?? "",
    },
    agents: (values.agents ?? []).slice(0, MAX_AGENTS).map((agent) => ({
      id: agent.id,
      description: agent.description,
      role:
        agent.role === "seller" || agent.role === "specialist"
          ? agent.role
          : "builder",
      model: agent.model,
      instructions: agent.instructions,
    })),
  };
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
