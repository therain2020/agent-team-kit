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
import { cn } from "@/lib/utils";
import type { SourceCandidate } from "@kit/source";
import {
  Download,
  ExternalLink,
  Globe2,
  RefreshCw,
  Search,
  ShieldAlert,
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

  async function install() {
    if (!selected?.manifest || !confirmed) {
      return;
    }
    setInstalling(true);
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: selected.repo,
          confirm: true,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        name?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("installFailed"));
      }
      toast.success(t("installed", { name: payload.name ?? selected.repo }));
      setSelected(null);
      setConfirmed(false);
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("installFailed"),
      );
    } finally {
      setInstalling(false);
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

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Search className="size-4 text-sky-400" />
              {t("marketTitle")}
            </h2>
            <span className="font-mono text-[10px] text-zinc-600">
              topic:agent-team-source
            </span>
          </div>
          <div className="flex gap-2">
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
          {error ? (
            <p className="mt-2 whitespace-pre-wrap text-[10px] text-red-300">
              {error}
            </p>
          ) : null}

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
        </section>
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
