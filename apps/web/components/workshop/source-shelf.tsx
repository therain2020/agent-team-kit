"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkshopPackView, WorkshopSourceView } from "@/lib/workshop-link";
import { ExternalLink, Globe2, Search, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

const TRUST_LABEL: Record<string, "success" | "info" | "warning"> = {
  builtin: "success",
  verified: "info",
  "third-party": "warning",
  community: "warning",
};

export function SourceShelf({
  sources,
  pack,
  scope,
  scoped,
  onScopeChange,
  onManage,
}: {
  sources: WorkshopSourceView[];
  pack: WorkshopPackView | null;
  scope: "pack" | "all";
  scoped: boolean;
  onScopeChange: (scope: "pack" | "all") => void;
  onManage: () => void;
}) {
  const t = useTranslations("workshopSurface");
  const [testing, setTesting] = useState<string | null>(null);
  const used = new Set(pack?.usedSources ?? []);

  async function test(source: string) {
    setTesting(source);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(source)}/test`,
        { method: "POST" },
      );
      const payload = (await response.json()) as {
        items?: unknown[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("testFailed"));
      }
      toast.success(t("testPassed", { count: payload.items?.length ?? 0 }));
    } catch (problem) {
      toast.error(problem instanceof Error ? problem.message : t("testFailed"));
    } finally {
      setTesting(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-zinc-900/60 p-0.5">
          <ScopeButton
            active={scope === "pack"}
            onClick={() => onScopeChange("pack")}
            disabled={!pack}
          >
            {t("scopePack")}
          </ScopeButton>
          <ScopeButton
            active={scope === "all"}
            onClick={() => onScopeChange("all")}
          >
            {t("scopeAll")}
          </ScopeButton>
        </div>
        <span className="font-mono text-[10px] text-zinc-600">
          {t("sourceCount", { count: sources.length })}
        </span>
      </div>

      {pack && scope === "pack" && !scoped ? (
        <p className="border-b border-border/60 bg-amber-500/[0.04] px-2 py-1.5 text-[10px] text-amber-300/80">
          {t("usedSourcesEmpty")}
        </p>
      ) : null}

      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {sources.length === 0 ? (
          <li className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
            {t("noSources")}
          </li>
        ) : (
          sources.map((source) => {
            const linked = used.has(source.name);
            return (
              <li
                key={source.name}
                data-source={source.name}
                className={cn(
                  "rounded-lg border px-2.5 py-2",
                  linked && scope === "pack"
                    ? "border-emerald-500/35 bg-emerald-500/[0.05]"
                    : "border-border bg-zinc-950/30",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-zinc-100">
                    {source.name}
                  </span>
                  {source.builtin ? (
                    <Badge variant="success">{t("builtinSource")}</Badge>
                  ) : (
                    <>
                      <Badge variant="outline">v{source.version}</Badge>
                      <Badge variant={TRUST_LABEL[source.trust] ?? "warning"}>
                        {source.trust}
                      </Badge>
                    </>
                  )}
                  {linked ? (
                    <Badge variant="info">{t("usedByPack")}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  {source.description || t("builtinSource")}
                </p>
                {source.builtin ? null : (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                    {t("sourceRepo", {
                      repo: source.repo,
                      commit: source.commit.slice(0, 8),
                    })}
                  </p>
                )}
                <div className="mt-1.5 flex items-center gap-2">
                  {source.builtin ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void test(source.name)}
                      disabled={testing === source.name}
                    >
                      <Zap className="size-3" />
                      {testing === source.name
                        ? t("testingSource")
                        : t("testSource")}
                    </Button>
                  )}
                  {source.homepage ? (
                    <a
                      href={source.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-zinc-500 hover:text-zinc-200"
                    >
                      <ExternalLink className="mr-1 inline size-3" />
                      {source.name}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>

      <footer className="flex items-center gap-1.5 border-t border-border p-2">
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          onClick={onManage}
        >
          <Search className="size-3.5" />
          {t("manageSources")}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a
            href="https://github.com/topics/agent-team-source"
            target="_blank"
            rel="noreferrer"
          >
            <Globe2 className="size-3.5" />
          </a>
        </Button>
      </footer>
    </>
  );
}

function ScopeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "rounded px-2 py-1 text-[10px] text-zinc-400 transition-colors",
        active && "bg-zinc-800 text-zinc-100",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {children}
    </button>
  );
}
