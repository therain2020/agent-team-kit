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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  SourceCandidateSummary,
  SourceDraftValues,
  SourceRiskSummary,
} from "@kit/job";
import type { SourceCandidate } from "@kit/source";
import {
  Download,
  ExternalLink,
  Globe2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export interface InstalledSourceView {
  name: string;
  version: string;
  description: string;
  homepage?: string;
  license?: string;
  repo: string;
  commit: string;
  trust: string;
}

interface SourceDraftResult {
  values: SourceDraftValues;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

const RISK_VARIANT: Record<
  SourceRiskSummary["level"],
  "success" | "warning" | "danger"
> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

function riskLabelKeys(level: SourceRiskSummary["level"]): string {
  return level === "high"
    ? "riskHigh"
    : level === "medium"
      ? "riskMedium"
      : "riskLow";
}

export function SourcesMarket({
  installed,
}: {
  installed: InstalledSourceView[];
}) {
  const t = useTranslations("sources");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SourceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SourceCandidate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [installing, setInstalling] = useState(false);

  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<SourceDraftResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftRepo, setDraftRepo] = useState<string | null>(null);
  const [draftConfirmed, setDraftConfirmed] = useState(false);

  const draftSelected: SourceCandidateSummary | null =
    draft?.values.candidates.find((item) => item.repo === draftRepo) ?? null;

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/sources?query=${encodeURIComponent(query)}`,
      );
      const payload = (await response.json()) as {
        candidates?: SourceCandidate[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("searchFailed"));
      }
      setResults(payload.candidates ?? []);
      if ((payload.candidates ?? []).length === 0) {
        toast.message(t("noResults"));
      }
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSearching(false);
    }
  }

  async function composeDraft() {
    if (!intent.trim()) {
      toast.error(t("intentPlaceholder"));
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "source", intent: intent.trim() }),
      });
      const payload = (await response.json()) as SourceDraftResult & {
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("draftFailed"));
      }
      setDraft({
        values: payload.values,
        rationale: payload.rationale ?? "",
        warnings: payload.warnings ?? [],
        model: payload.model === "live" ? "live" : "heuristic",
      });
      setDraftRepo(payload.values.repo || null);
      setDraftConfirmed(false);
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setDrafting(false);
    }
  }

  async function installRepo(repo: string): Promise<boolean> {
    setInstalling(true);
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, confirm: true }),
      });
      const payload = (await response.json()) as {
        error?: string;
        name?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("installFailed"));
      }
      toast.success(t("installed", { name: payload.name ?? repo }));
      router.refresh();
      return true;
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("installFailed"),
      );
      return false;
    } finally {
      setInstalling(false);
    }
  }

  async function install() {
    if (!selected?.manifest || !confirmed) {
      return;
    }
    if (await installRepo(selected.repo)) {
      setSelected(null);
      setConfirmed(false);
    }
  }

  async function installDraft() {
    if (!draftSelected || !draftConfirmed) {
      return;
    }
    if (await installRepo(draftSelected.repo)) {
      setDraftConfirmed(false);
    }
  }

  async function remove(name: string) {
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? t("removeFailed"));
      }
      toast.success(t("removed", { name }));
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("removeFailed"),
      );
    }
  }

  async function test(name: string) {
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(name)}/test`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        items?: Array<{ title: string; url: string }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("testFailed"));
      }
      toast.success(t("testPassed", { count: payload.items?.length ?? 0 }), {
        description: payload.items?.[0]?.title,
      });
    } catch (problem) {
      toast.error(problem instanceof Error ? problem.message : t("testFailed"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[11px] text-amber-200/90">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <p>{t("securityNotice")}</p>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Sparkles className="size-4 text-violet-400" />
          {t("intentTitle")}
        </h2>
        <p className="mb-2 text-[10px] text-zinc-500">{t("intentHint")}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder={t("intentPlaceholder")}
            rows={2}
            className="text-[11px] leading-relaxed"
          />
          <Button
            className="sm:w-40"
            onClick={composeDraft}
            disabled={drafting || !intent.trim()}
          >
            <Sparkles className={cn("size-3.5", drafting && "animate-pulse")} />
            {drafting ? t("drafting") : t("draft")}
          </Button>
        </div>

        {draft ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={draft.model === "live" ? "info" : "outline"}>
                {draft.model === "live" ? t("draftLive") : t("draftHeuristic")}
              </Badge>
              {draft.values.risk ? (
                <Badge variant={RISK_VARIANT[draft.values.risk.level]}>
                  {t(riskLabelKeys(draft.values.risk.level))}
                </Badge>
              ) : null}
              <span className="text-[10px] text-zinc-500">
                {t("draftSelectHint")}
              </span>
            </div>

            {draft.values.repo === "" ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-zinc-500">
                {t("draftEmpty")}
              </p>
            ) : (
              <>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    {t("draftCandidates", {
                      count: draft.values.candidates.length,
                    })}
                  </p>
                  <ul className="space-y-1.5">
                    {draft.values.candidates.map((candidate) => {
                      const installable = Boolean(candidate.manifest);
                      const active = candidate.repo === draftRepo;
                      return (
                        <li key={candidate.repo}>
                          <button
                            type="button"
                            disabled={!installable}
                            onClick={() => {
                              setDraftRepo(candidate.repo);
                              setDraftConfirmed(false);
                            }}
                            className={cn(
                              "flex w-full flex-wrap items-center gap-1.5 rounded-lg border px-3 py-2 text-left transition-colors",
                              active
                                ? "border-violet-500/50 bg-violet-500/[0.06]"
                                : "border-border bg-zinc-950/30 hover:border-zinc-600",
                              !installable && "cursor-not-allowed opacity-50",
                            )}
                          >
                            <span className="font-mono text-xs text-zinc-200">
                              {candidate.repo}
                            </span>
                            {candidate.manifest ? (
                              <Badge variant="success">
                                {candidate.manifest.name}@
                                {candidate.manifest.version}
                              </Badge>
                            ) : (
                              <Badge variant="danger">
                                {t("notInstallable")}
                              </Badge>
                            )}
                            <span className="text-[10px] text-amber-300/80">
                              ★ {candidate.stars}
                            </span>
                            <Badge variant={RISK_VARIANT[candidate.risk.level]}>
                              {t(riskLabelKeys(candidate.risk.level))}
                            </Badge>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {draftSelected?.risk ? (
                  <RiskPanel
                    candidate={draftSelected}
                    reason={
                      draftSelected.repo === draft.values.repo
                        ? draft.values.reason
                        : ""
                    }
                    rationale={draft.rationale}
                    warnings={draft.warnings}
                  />
                ) : null}

                {draftSelected ? (
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-200/90">
                      <input
                        type="checkbox"
                        checked={draftConfirmed}
                        onChange={(event) =>
                          setDraftConfirmed(event.target.checked)
                        }
                        className="mt-0.5 size-3.5 accent-amber-500"
                      />
                      <span>{t("confirmCheckbox")}</span>
                    </label>
                    <Button
                      size="sm"
                      onClick={installDraft}
                      disabled={!draftConfirmed || installing}
                    >
                      <Download className="size-3.5" />
                      {installing ? t("installing") : t("installSelected")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="whitespace-pre-wrap rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-2 text-[10px] text-red-300">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Globe2 className="size-4 text-emerald-400" />
              {t("installedTitle")}
            </h2>
            <Badge variant="outline">{installed.length}</Badge>
          </div>
          {installed.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
              {t("noInstalled")}
            </p>
          ) : (
            <ul className="space-y-2">
              {installed.map((source) => (
                <li
                  key={source.name}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {source.name}
                    </span>
                    <Badge variant="outline">v{source.version}</Badge>
                    <Badge variant="warning">{t("thirdParty")}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    {source.description || "—"}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {source.repo}@{source.commit.slice(0, 8)}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => test(source.name)}
                    >
                      <Zap className="size-3.5" />
                      {t("test")}
                    </Button>
                    {source.homepage ? (
                      <a
                        href={source.homepage}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-zinc-500 hover:text-zinc-200"
                      >
                        <ExternalLink className="mr-1 inline size-3" />
                        {t("homepage")}
                      </a>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-red-300/80 hover:text-red-200"
                      onClick={() => remove(source.name)}
                    >
                      <Trash2 className="size-3.5" />
                      {t("remove")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="rounded-xl border border-border bg-card p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-zinc-200">
            <Search className="size-4 text-sky-400" />
            {t("manualTitle")}
          </summary>
          <p className="mt-1 text-[10px] text-zinc-500">{t("manualHint")}</p>
          <div className="mt-3 flex gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void search();
                }
              }}
              placeholder={t("searchPlaceholder")}
              className="h-8 text-[11px]"
            />
            <Button size="sm" onClick={search} disabled={searching}>
              <RefreshCw
                className={cn("size-3.5", searching && "animate-spin")}
              />
              {t("search")}
            </Button>
          </div>
          <ul className="mt-3 space-y-2">
            {results.map((candidate) => {
              const installedAlready = installed.some(
                (source) => source.name === candidate.manifest?.metadata.name,
              );
              return (
                <li
                  key={candidate.repo}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {candidate.repo}
                    </span>
                    <span className="text-[10px] text-amber-300/80">
                      ★ {candidate.stars}
                    </span>
                    {candidate.manifest ? (
                      <Badge variant="success">
                        {candidate.manifest.metadata.name}@
                        {candidate.manifest.metadata.version}
                      </Badge>
                    ) : (
                      <Badge variant="danger">{t("invalidManifest")}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    {candidate.description || "—"}
                  </p>
                  {candidate.manifestError ? (
                    <p className="mt-1 text-[10px] text-red-300/80">
                      {candidate.manifestError}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <a
                      href={`${candidate.htmlUrl}/blob/HEAD/source.yaml`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200"
                    >
                      <ExternalLink className="size-3" />
                      {t("previewManifest")}
                    </a>
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={!candidate.manifest || installedAlready}
                      onClick={() => {
                        setSelected(candidate);
                        setConfirmed(false);
                      }}
                    >
                      <Download className="size-3.5" />
                      {installedAlready ? t("installedLabel") : t("install")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {results.length === 0 && !searching ? (
            <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
              {t("searchHint")}
            </p>
          ) : null}
        </details>
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setConfirmed(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("confirmDescription")}</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="space-y-2 text-[11px] text-zinc-400">
              <p className="font-mono text-zinc-200">{selected.repo}</p>
              <p>
                {selected.manifest?.metadata.name}@
                {selected.manifest?.metadata.version} ·{" "}
                {selected.manifest?.spec.type}
              </p>
              <p>{selected.manifest?.metadata.description}</p>
              <p className="font-mono text-[10px] text-zinc-600">
                {selected.manifest?.spec.request.url}
              </p>
              <label className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-200/90">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-amber-500"
                />
                <span>{t("confirmCheckbox")}</span>
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setConfirmed(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button onClick={install} disabled={!confirmed || installing}>
              {installing ? t("installing") : t("installButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RiskPanel({
  candidate,
  reason,
  rationale,
  warnings,
}: {
  candidate: SourceCandidateSummary;
  reason: string;
  rationale: string;
  warnings: string[];
}) {
  const t = useTranslations("sources");
  const risk = candidate.risk;
  const rows: Array<{ key: string; label: string; value: string }> = [
    { key: "network", label: t("riskNetwork"), value: risk.network },
    {
      key: "endpoint",
      label: t("riskEndpoint"),
      value: risk.endpoint || "—",
    },
    { key: "trust", label: t("riskTrust"), value: risk.trust },
    { key: "auth", label: t("riskAuth"), value: risk.auth },
    { key: "rate", label: t("riskRateLimits"), value: risk.rateLimits },
    { key: "tos", label: t("riskTos"), value: risk.tos },
    {
      key: "credibility",
      label: t("riskCredibility"),
      value: risk.credibility,
    },
    { key: "secret", label: t("riskSecret"), value: risk.secret },
  ];
  return (
    <div className="space-y-2 rounded-lg border border-border bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          {t("riskTitle")}
        </span>
        <Badge variant={RISK_VARIANT[risk.level]}>
          {t(riskLabelKeys(risk.level))}
        </Badge>
        <span className="font-mono text-[10px] text-zinc-500">
          {candidate.repo}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-zinc-500">{row.label}</dt>
            <dd
              className={cn(
                "break-all",
                row.key === "secret" && risk.level === "high" && "text-red-300",
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {risk.notes.length > 0 ? (
        <ul className="space-y-0.5 text-[10px] text-amber-200/80">
          {risk.notes.map((note) => (
            <li key={note}>• {note}</li>
          ))}
        </ul>
      ) : null}
      {reason ? (
        <p className="text-[10px] text-zinc-300">
          <span className="text-zinc-500">{t("draftReason")}: </span>
          {reason}
        </p>
      ) : null}
      {rationale ? (
        <p className="text-[10px] text-zinc-400">
          <span className="text-zinc-500">{t("draftRationale")}: </span>
          {rationale}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="space-y-0.5 text-[10px] text-amber-300/80">
          {warnings.map((warning) => (
            <li key={warning}>• {warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
