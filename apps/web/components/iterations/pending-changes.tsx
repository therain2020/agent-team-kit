"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useRiskLabel, useStatusLabel } from "@/lib/iteration-labels";
import { ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface PendingChange {
  ticketId: string;
  iterationId: string;
  taskId: string;
  domain: string | null;
  goal: string | null;
  risk: "low" | "medium" | "high";
  changedFiles: string[];
  baseSha: string;
  diffArtifactId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function PendingChanges({ iterationId }: { iterationId: string }) {
  const t = useTranslations("pendingChanges");
  const common = useTranslations("common");
  const statusLabel = useStatusLabel();
  const riskLabel = useRiskLabel();
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(iterationId)}/changes`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { changes?: PendingChange[] };
      setChanges(payload.changes ?? []);
    } catch {
      // a later refresh will retry
    }
  }, [iterationId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const apply = async (ticketId: string) => {
    const note = (notes[ticketId] ?? "").trim();
    if (!note) {
      toast.error(t("noteRequired"));
      return;
    }
    setBusy(ticketId);
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(iterationId)}/changes/${encodeURIComponent(ticketId)}/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note }),
        },
      );
      const payload = (await response.json()) as {
        status?: string;
        commit?: string;
        reason?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      if (payload.status === "applied" && payload.commit) {
        toast.success(t("appliedAs", { commit: payload.commit.slice(0, 8) }));
      } else {
        toast.success(
          t("applyFinished", {
            status: payload.status
              ? statusLabel(payload.status)
              : common("unknown"),
          }),
        );
      }
      setNotes((previous) => ({ ...previous, [ticketId]: "" }));
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("applyFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (changes.length === 0) {
    return null;
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-amber-200">
          <ShieldAlert className="size-4" />
          {t("title", { count: changes.length })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {changes.map((change) => (
          <div
            key={change.ticketId}
            className="rounded-md border border-amber-500/20 bg-background/50 px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={change.risk === "high" ? "danger" : "warning"}>
                {t("risk", { level: riskLabel(change.risk) })}
              </Badge>
              {change.domain ? (
                <Badge variant="violet">{change.domain}</Badge>
              ) : null}
              <span className="font-mono text-[10px] text-zinc-400">
                {change.taskId}
              </span>
              <span className="text-[10px] text-zinc-500">
                {t("base", { sha: change.baseSha.slice(0, 8) })}
              </span>
              {change.diffArtifactId ? (
                <a
                  className="text-[10px] text-sky-400 hover:text-sky-300"
                  href={`/api/iterations/${encodeURIComponent(iterationId)}/artifact?artifactId=${encodeURIComponent(change.diffArtifactId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("diff")}
                </a>
              ) : null}
            </div>
            {change.goal ? (
              <p className="mt-1 line-clamp-2 text-xs text-zinc-300">
                {change.goal}
              </p>
            ) : null}
            {change.changedFiles.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {change.changedFiles.slice(0, 8).map((file) => (
                  <span
                    key={file}
                    className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                  >
                    {file}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={notes[change.ticketId] ?? ""}
                onChange={(event) =>
                  setNotes((previous) => ({
                    ...previous,
                    [change.ticketId]: event.target.value,
                  }))
                }
                placeholder={t("notePlaceholder")}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                onClick={() => void apply(change.ticketId)}
                disabled={busy === change.ticketId}
              >
                {busy === change.ticketId ? t("applying") : t("apply")}
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
