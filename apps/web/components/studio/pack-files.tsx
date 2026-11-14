"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FilePlus2, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const ITERATION_TEMPLATE = `apiVersion: agentteam/v1
kind: IterationPack
planner:
  model: deepseek-pro
  maxTasks: 4
domains: {}
autoApply:
  low: true
  medium: false
  high: false
`;

export function PackFiles({
  dirName,
  initialFiles,
}: {
  dirName: string;
  initialFiles: string[];
}) {
  const t = useTranslations("studio");
  const [files, setFiles] = useState(initialFiles);
  const [path, setPath] = useState(initialFiles[0] ?? "team.yaml");
  const [content, setContent] = useState("");
  const [exists, setExists] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetch(
      `/api/packs/${encodeURIComponent(dirName)}/file?path=${encodeURIComponent(path)}`,
    )
      .then((response) => response.json())
      .then(
        (payload: {
          exists?: boolean;
          content?: string;
          error?: string;
        }) => {
          if (cancelled) {
            return;
          }
          if (payload.error) {
            throw new Error(payload.error);
          }
          const found = payload.exists === true;
          setExists(found);
          setContent(
            found
              ? (payload.content ?? "")
              : path === "iteration.yaml"
                ? ITERATION_TEMPLATE
                : "",
          );
        },
      )
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dirName, path]);

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/file`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, content }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "save failed");
      }
      setExists(true);
      if (!files.includes(path)) {
        setFiles((current) => [...current, path]);
      }
      toast.success(t("files.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const hasIteration = files.includes("iteration.yaml");

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2 rounded-lg border border-border bg-card p-2">
        <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("files.title")}
        </p>
        {files.map((file) => (
          <button
            key={file}
            type="button"
            onClick={() => setPath(file)}
            className={cn(
              "w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
              file === path && "bg-zinc-900 text-zinc-100",
            )}
          >
            {file}
          </button>
        ))}
        {!hasIteration ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setPath("iteration.yaml")}
          >
            <FilePlus2 className="size-3.5" />
            {t("files.newIteration")}
          </Button>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <span className="font-mono text-xs text-zinc-200">{path}</span>
            <span className="ml-2 text-[10px] text-zinc-500">
              {exists ? t("files.exists") : t("files.missing")}
            </span>
          </div>
          <Button size="sm" onClick={save} disabled={busy}>
            <Save className="size-3.5" />
            {t("save")}
          </Button>
        </div>
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={26}
          className="font-mono text-[11px] leading-relaxed"
          aria-label={path}
        />
        <p className="text-[10px] text-zinc-600">{t("files.hint")}</p>
      </div>
    </div>
  );
}
