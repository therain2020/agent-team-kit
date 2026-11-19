"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatCny, formatNumber } from "@/lib/utils";
import type { ArtifactVersion, Manifest } from "@kit/core";
import { Copy, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "./markdown";

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface LineageItem {
  artifactId: string;
  version: number;
  label: string;
  href: string;
}

export function ArtifactViewer({
  artifact,
  manifest,
  kind,
  content,
  truncated,
  unavailable,
  diff,
  diffLabel,
  lineage,
}: {
  artifact: ArtifactVersion;
  manifest: Manifest | null;
  kind: string;
  content: string;
  truncated: boolean;
  unavailable?: boolean;
  diff: DiffPart[] | null;
  diffLabel?: string;
  lineage: LineageItem[];
}) {
  const t = useTranslations("artifact");
  const common = useTranslations("common");
  const parsedJson = useMemo(() => {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  }, [content]);

  const isJson = parsedJson !== null;
  const [sourceMode, setSourceMode] = useState(false);
  const displayContent = isJson ? JSON.stringify(parsedJson, null, 2) : content;

  async function copy() {
    try {
      await navigator.clipboard.writeText(displayContent);
      toast.success(t("copied"));
    } catch {
      toast.error(t("clipboardUnavailable"));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-px-line bg-px-panel2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-bold text-px-text">
            {artifact.artifactId}
          </span>
          <Badge variant="outline">v{artifact.version}</Badge>
          <Badge variant="default">{t(`kind.${kind}`)}</Badge>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={copy}
              className="h-7 px-2 text-xs"
            >
              <Copy className="size-3.5" />
              {t("copy")}
            </Button>
            {!isJson ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSourceMode((value) => !value)}
                className="h-7 px-2 text-xs"
              >
                {sourceMode ? t("rendered") : t("source")}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-px-muted">
          <span>
            {t("producer")}{" "}
            <span className="text-px-text">
              {manifest?.producer.agentId ?? common("unknown")}
            </span>
          </span>
          <span>
            {t("model")}{" "}
            <span className="text-px-text">
              {manifest?.producer.modelId ?? common("unknown")}
            </span>
          </span>
          <span>
            {t("mode")}{" "}
            <span className="text-px-text">
              {manifest?.runMode ?? common("unknown")}
            </span>
          </span>
          <span>
            {t("cost")}{" "}
            <span className="text-px-text">
              {formatCny(manifest?.cost.amount ?? 0)}
            </span>
          </span>
          <span>
            {t("tokens")}{" "}
            <span className="text-px-text tabular-nums">
              {formatNumber(manifest?.cost.tokens ?? 0)}
            </span>
          </span>
          <span>
            {t("stage")}{" "}
            <span className="font-mono text-px-muted">
              {manifest?.stageId ?? common("unknown")}
            </span>
          </span>
        </div>
      </div>

      <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-px-line bg-px-ink/40 px-4 py-2">
          <TabsList>
            <TabsTrigger value="content">{t("content")}</TabsTrigger>
            <TabsTrigger value="manifest">{t("manifest")}</TabsTrigger>
            <TabsTrigger value="lineage">
              {t("lineage")}
              {lineage.length > 0 ? ` (${lineage.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="diff" disabled={!diff}>
              {t("diff")}
            </TabsTrigger>
          </TabsList>
          {truncated ? (
            <span className="font-mono text-[10.5px] text-amber-300">
              {t("previewTruncated")}
            </span>
          ) : null}
        </div>

        <TabsContent
          value="content"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {unavailable ? (
            <p className="text-xs text-amber-400">{t("unavailable")}</p>
          ) : sourceMode || isJson ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-px-text">
              {displayContent || t("empty")}
            </pre>
          ) : (
            <Markdown>{displayContent || t("empty")}</Markdown>
          )}
        </TabsContent>

        <TabsContent
          value="manifest"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-px-text">
            {JSON.stringify(manifest, null, 2)}
          </pre>
        </TabsContent>

        <TabsContent
          value="lineage"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {lineage.length === 0 ? (
            <p className="text-xs text-px-muted">{t("noInputs")}</p>
          ) : (
            <ul className="space-y-2">
              {lineage.map((item) => (
                <li key={`${item.artifactId}:${item.version}`}>
                  <Link
                    href={item.href}
                    className="flex items-center justify-between rounded-none border border-px-line bg-px-panel2 px-3 py-2 text-xs text-px-text transition-colors hover:border-px-line2 hover:bg-px-panel3"
                  >
                    <span className="font-mono">
                      {item.label} · {item.artifactId} v{item.version}
                    </span>
                    <ExternalLink className="size-3.5 text-px-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent
          value="diff"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {diff ? (
            <div>
              {diffLabel ? (
                <p className="mb-2 text-[11px] text-px-muted">{diffLabel}</p>
              ) : null}
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                {diff.map((part) => (
                  <span
                    key={`${part.added ? "add" : part.removed ? "del" : "ctx"}-${part.value.length}-${part.value.slice(0, 32)}`}
                    className={cn(
                      "block",
                      part.added && "bg-emerald-500/10 text-emerald-300",
                      part.removed && "bg-red-500/10 text-red-300",
                      !part.added && !part.removed && "text-px-muted",
                    )}
                  >
                    {part.value
                      .split("\n")
                      .filter((line, i, all) =>
                        i === all.length - 1 ? line !== "" : true,
                      )
                      .map(
                        (line) =>
                          `${part.added ? "+" : part.removed ? "-" : " "} ${line}`,
                      )
                      .join("\n")}
                  </span>
                ))}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-px-muted">{t("noDiff")}</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
