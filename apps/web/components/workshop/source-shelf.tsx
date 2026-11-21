"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkshopSourceView } from "@/lib/workshop-link";
import { ExternalLink, Globe2, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

const TRUST_VARIANT: Record<string, "success" | "info" | "warning"> = {
  builtin: "success",
  verified: "info",
  "third-party": "warning",
  community: "warning",
};

/**
 * Local source library (`/sources`, 88 §3.4 M2). Sources are discovery output
 * pinned to `repo@commit`; the panel stays read/test-only and links back to the
 * workshop for new discoveries.
 */
export function SourceShelf({ sources }: { sources: WorkshopSourceView[] }) {
  const t = useTranslations("sourcesLibrary");
  const [testing, setTesting] = useState<string | null>(null);

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
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] text-zinc-500">{t("countHint")}</span>
        <span className="font-mono text-[10px] text-zinc-600">
          {t("count", { count: sources.length })}
        </span>
      </div>

      <ul className="space-y-1.5 overflow-y-auto p-2">
        {sources.length === 0 ? (
          <li className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
            {t("empty")}
          </li>
        ) : (
          sources.map((source) => (
            <li
              key={source.name}
              data-source={source.name}
              className="rounded-lg border border-border bg-zinc-950/30 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs text-zinc-100">
                  {source.name}
                </span>
                {source.builtin ? (
                  <Badge variant="success">{t("builtin")}</Badge>
                ) : (
                  <>
                    <Badge variant="outline">v{source.version}</Badge>
                    <Badge variant={TRUST_VARIANT[source.trust] ?? "warning"}>
                      {source.trust}
                    </Badge>
                  </>
                )}
              </div>
              {source.description ? (
                <p className="mt-1 text-[11px] text-zinc-400">
                  {source.description}
                </p>
              ) : null}
              {source.builtin ? null : (
                <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                  {t("repoAtCommit", {
                    repo: source.repo,
                    commit: source.commit.slice(0, 8),
                  })}
                </p>
              )}
              {source.builtin ? null : (
                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => void test(source.name)}
                    disabled={testing === source.name}
                  >
                    <Zap className="size-3" />
                    {testing === source.name ? t("testing") : t("test")}
                  </Button>
                  {source.homepage ? (
                    <a
                      href={source.homepage}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200"
                    >
                      <ExternalLink className="size-3" />
                      {t("homepage")}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-600">
                      <Globe2 className="size-3" />
                      {source.repo}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
