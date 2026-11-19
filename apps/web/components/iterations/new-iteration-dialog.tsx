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
import { ArrowLeft, Play, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface Project {
  id: string;
  name: string;
  path: string;
  source: "kit" | "workspace";
  checks: string[];
  branch?: string | null;
  defaultBranch?: string | null;
  onDefaultBranch?: boolean;
}

interface Draft {
  kind: "iteration";
  projectId: string;
  packDir: string;
  domain: string;
  maxTasks: number;
  acceptance: string;
  applyMode: "none" | "low" | "low-medium";
  runMode: "DRY_RUN";
}

interface DraftResponse {
  draft: Draft;
  rationale: string;
  warnings: string[];
  project: Project;
  model: "live" | "heuristic";
}

const DOMAINS = ["cyber", "ux", "perf", "docs"];

export function NewIterationDialog({
  defaultOpen = false,
  triggerLabel,
  onOpenChange,
}: {
  defaultOpen?: boolean;
  triggerLabel?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("newIteration");
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [step, setStep] = useState<"goal" | "review">("goal");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [liveAllowed, setLiveAllowed] = useState(false);
  const [projectId, setProjectId] = useState("self");
  const [customPath, setCustomPath] = useState("");
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [domain, setDomain] = useState("cyber");
  const [maxTasks, setMaxTasks] = useState("2");
  const [acceptance, setAcceptance] = useState("");
  const [applyMode, setApplyMode] = useState<"none" | "low" | "low-medium">(
    "low",
  );
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState<"draft" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultOpen) {
      setOpen(true);
    }
  }, [defaultOpen]);

  const loadProjects = useCallback(async () => {
    setProjectsError(null);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = (await response.json()) as {
        projects?: Project[];
        liveAllowed?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.projects) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setProjects(payload.projects);
      setLiveAllowed(payload.liveAllowed === true);
      setProjectId((current) =>
        payload.projects?.some((project) => project.id === current)
          ? current
          : (payload.projects?.[0]?.id ?? "self"),
      );
    } catch (cause) {
      setProjectsError(cause instanceof Error ? cause.message : "");
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadProjects();
    }
  }, [open, loadProjects]);

  const generate = async () => {
    setError(null);
    if (!goal.trim()) {
      setError(t("goalRequired"));
      return;
    }
    setPending("draft");
    try {
      const customTarget = customPath.trim();
      const response = await fetch("/api/jobs/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          ...(customTarget ? { projectPath: customTarget } : { projectId }),
        }),
      });
      const payload = (await response.json()) as DraftResponse & {
        error?: string;
      };
      if (!response.ok || !payload.draft) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setDraft(payload);
      setDomain(payload.draft.domain);
      setMaxTasks(String(payload.draft.maxTasks));
      setAcceptance(payload.draft.acceptance);
      setApplyMode(payload.draft.applyMode);
      setLive(false);
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("draftFailed"));
    } finally {
      setPending(null);
    }
  };

  const reset = () => {
    setStep("goal");
    setDraft(null);
    setError(null);
    setLive(false);
    setCustomPath("");
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      reset();
    }
    onOpenChange?.(next);
  };

  const start = async () => {
    if (!draft) {
      return;
    }
    setError(null);
    setPending("start");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "iteration",
          projectPath: draft.project.path,
          packDir: draft.draft.packDir,
          goal: goal.trim(),
          acceptance: acceptance.trim() || undefined,
          domain,
          maxTasks: Number(maxTasks) || 1,
          applyMode,
          runMode: live ? "LIVE" : "DRY_RUN",
        }),
      });
      const payload = (await response.json()) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !payload.jobId) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      toast.success(
        t("started", { jobId: payload.jobId, project: draft.project.name }),
      );
      handleOpenChange(false);
      router.push(`/world?run=${encodeURIComponent(payload.jobId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("startFailed"));
    } finally {
      setPending(null);
    }
  };

  const selectedProject = projects.find((project) => project.id === projectId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Play className="size-3.5" />
          {triggerLabel ?? t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {step === "goal" ? t("goalDescription") : t("reviewDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "goal" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="iteration-project"
                className="text-xs font-medium text-zinc-300"
              >
                {t("project")}
              </label>
              <select
                id="iteration-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                    {project.source === "kit" ? ` ${t("kitRepository")}` : ""}
                  </option>
                ))}
              </select>
              {customPath.trim() ? (
                <>
                  <p className="font-mono text-[10px] text-zinc-500">
                    {customPath.trim()}
                  </p>
                  <p className="text-[10px] text-zinc-600">
                    {t("isolationNote")}
                  </p>
                </>
              ) : selectedProject ? (
                <>
                  <p className="font-mono text-[10px] text-zinc-500">
                    {selectedProject.path}
                    {selectedProject.checks.length > 0
                      ? ` · ${t("checks", { checks: selectedProject.checks.join(", ") })}`
                      : ` · ${t("noChecks")}`}
                  </p>
                  <p className="text-[10px] text-zinc-600">
                    {t("isolationNote")}
                  </p>
                </>
              ) : null}
              {projectsError !== null ? (
                <p className="text-[11px] text-red-300">
                  {t("projectLoadFailed", {
                    error: projectsError || t("draftFailed"),
                  })}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="iteration-custom-path"
                className="text-xs font-medium text-zinc-300"
              >
                {t("customPathLabel")}
              </label>
              <Input
                id="iteration-custom-path"
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
                placeholder={t("customPathPlaceholder")}
                className="h-9 text-xs"
              />
              <p className="text-[10px] text-zinc-600">{t("customPathHint")}</p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="iteration-goal"
                className="text-xs font-medium text-zinc-300"
              >
                {t("goal")}
              </label>
              <Textarea
                id="iteration-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t("goalPlaceholder")}
                className="min-h-24 text-sm"
              />
            </div>

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : draft ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                <Badge variant="violet">{draft.project.name}</Badge>
                <span className="font-mono text-[10px] text-zinc-500">
                  {draft.project.path}
                </span>
                <Badge variant={draft.model === "live" ? "success" : "outline"}>
                  {draft.model === "live"
                    ? t("aiProposal")
                    : t("heuristicProposal")}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-zinc-200">{goal}</p>
              <p className="mt-1 text-[11px] text-zinc-400">
                {draft.rationale}
              </p>
            </div>

            {draft.warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {draft.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="review-domain"
                  className="text-xs font-medium text-zinc-300"
                >
                  {t("domain")}
                </label>
                <select
                  id="review-domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
                >
                  {(DOMAINS.includes(domain)
                    ? DOMAINS
                    : [domain, ...DOMAINS]
                  ).map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="review-tasks"
                  className="text-xs font-medium text-zinc-300"
                >
                  {t("taskCount")}
                </label>
                <Input
                  id="review-tasks"
                  type="number"
                  min={1}
                  max={20}
                  value={maxTasks}
                  onChange={(event) => setMaxTasks(event.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="review-apply"
                  className="text-xs font-medium text-zinc-300"
                >
                  {t("applyMode")}
                </label>
                <select
                  id="review-apply"
                  value={applyMode}
                  onChange={(event) =>
                    setApplyMode(
                      event.target.value as "none" | "low" | "low-medium",
                    )
                  }
                  disabled={!live}
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring disabled:opacity-50"
                >
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="low-medium">low-medium</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="review-acceptance"
                className="text-xs font-medium text-zinc-300"
              >
                {t("acceptance")}
              </label>
              <Textarea
                id="review-acceptance"
                value={acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
                className="min-h-16 text-xs"
              />
            </div>

            <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={live}
                disabled={!liveAllowed}
                onChange={(event) => setLive(event.target.checked)}
                className="mt-0.5 size-3.5 accent-emerald-500 disabled:opacity-50"
              />
              <span>
                <span className="block text-xs font-medium text-zinc-300">
                  {t("live")}
                </span>
                <span className="block text-[10px] text-zinc-500">
                  {liveAllowed ? t("liveAllowed") : t("liveBlocked")}
                </span>
              </span>
            </label>

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : null}

        <DialogFooter>
          {step === "goal" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={pending !== null}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void generate()}
                disabled={pending !== null || projects.length === 0}
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
                  setStep("goal");
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
                onClick={() => void start()}
                disabled={
                  pending !== null ||
                  (live && draft.project.onDefaultBranch === false)
                }
              >
                <Play className="size-3.5" />
                {pending === "start" ? t("starting") : t("approveStart")}
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
