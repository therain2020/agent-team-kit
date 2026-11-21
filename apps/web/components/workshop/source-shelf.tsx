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
import type {
  WorkshopSourceHealthView,
  WorkshopSourceView,
} from "@/lib/workshop-link";
import {
  ExternalLink,
  Globe2,
  Pencil,
  PowerOff,
  Wallet,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
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
 * pinned to `repo@commit`; the observer can test, edit the YAML, set a budget
 * or retire a source (98 I-5). Retirement keeps the manifest and history.
 */
export function SourceShelf({
  sources,
  health = [],
}: {
  sources: WorkshopSourceView[];
  health?: WorkshopSourceHealthView[];
}) {
  const t = useTranslations("sourcesLibrary");
  const router = useRouter();
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkshopSourceView | null>(null);
  const [editYaml, setEditYaml] = useState("");
  const [loadingYaml, setLoadingYaml] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [budgetFor, setBudgetFor] = useState<WorkshopSourceView | null>(null);
  const [dailyCost, setDailyCost] = useState("0");
  const [maxItems, setMaxItems] = useState("20");
  const [savingBudget, setSavingBudget] = useState(false);
  const [retiring, setRetiring] = useState<WorkshopSourceView | null>(null);
  const [retireReason, setRetireReason] = useState("");
  const [retireBusy, setRetireBusy] = useState(false);
  const healthBy = new Map(health.map((entry) => [entry.sourceId, entry]));

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

  async function openEdit(source: WorkshopSourceView) {
    setEditing(source);
    setLoadingYaml(true);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(source.name)}`,
      );
      const payload = (await response.json()) as {
        yaml?: string;
        error?: string;
      };
      if (!response.ok || typeof payload.yaml !== "string") {
        throw new Error(payload.error ?? t("editFailed"));
      }
      setEditYaml(payload.yaml);
    } catch (problem) {
      toast.error(problem instanceof Error ? problem.message : t("editFailed"));
      setEditing(null);
    } finally {
      setLoadingYaml(false);
    }
  }

  async function saveEdit() {
    if (!editing) {
      return;
    }
    setSavingEdit(true);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(editing.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ yaml: editYaml }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        issues?: Array<{ message: string }>;
      };
      if (!response.ok) {
        throw new Error(
          payload.issues?.[0]?.message ?? payload.error ?? t("editFailed"),
        );
      }
      toast.success(t("saved"));
      setEditing(null);
      router.refresh();
    } catch (problem) {
      toast.error(problem instanceof Error ? problem.message : t("editFailed"));
    } finally {
      setSavingEdit(false);
    }
  }

  function openBudget(source: WorkshopSourceView) {
    setBudgetFor(source);
    setDailyCost(String(source.budget?.dailyCostCny ?? 0));
    setMaxItems(String(source.budget?.maxItemsPerRun ?? 20));
  }

  async function saveBudget() {
    if (!budgetFor) {
      return;
    }
    setSavingBudget(true);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(budgetFor.name)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            budget: {
              dailyCostCny: Number(dailyCost),
              maxItemsPerRun: Number(maxItems),
            },
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("budgetFailed"));
      }
      toast.success(t("budgetSaved"));
      setBudgetFor(null);
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("budgetFailed"),
      );
    } finally {
      setSavingBudget(false);
    }
  }

  async function retire() {
    if (!retiring) {
      return;
    }
    setRetireBusy(true);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(retiring.name)}/retire`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: retireReason.trim() || undefined }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("retireFailed"));
      }
      toast.success(t("retiredSuccess", { name: retiring.name }));
      setRetiring(null);
      setRetireReason("");
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("retireFailed"),
      );
    } finally {
      setRetireBusy(false);
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
          sources.map((source) => {
            const yieldView = healthBy.get(source.name);
            return (
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
                  {source.retired ? (
                    <Badge variant="danger">{t("retiredBadge")}</Badge>
                  ) : null}
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
                {yieldView ? (
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {t("yield", {
                      runs: yieldView.runs,
                      events: yieldView.eventsCreated,
                      items: yieldView.itemsCollected,
                      ratio: Math.round(yieldView.eventRatio * 100),
                    })}
                  </p>
                ) : null}
                {source.budget ? (
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                    {t("budgetLabel", {
                      cost: source.budget.dailyCostCny,
                      items: source.budget.maxItemsPerRun,
                    })}
                  </p>
                ) : null}
                {source.builtin ? null : (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void test(source.name)}
                      disabled={testing === source.name || source.retired}
                    >
                      <Zap className="size-3" />
                      {testing === source.name ? t("testing") : t("test")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void openEdit(source)}
                    >
                      <Pencil className="size-3" />
                      {t("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => openBudget(source)}
                    >
                      <Wallet className="size-3" />
                      {t("budget")}
                    </Button>
                    {source.retired ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px] text-amber-200/80 hover:text-amber-100"
                        onClick={() => setRetiring(source)}
                      >
                        <PowerOff className="size-3" />
                        {t("retire")}
                      </Button>
                    )}
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
            );
          })
        )}
      </ul>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("editTitle", { name: editing?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("editHint")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={loadingYaml ? t("loading") : editYaml}
            onChange={(event) => setEditYaml(event.target.value)}
            rows={14}
            className="font-mono text-[11px]"
            disabled={loadingYaml || savingEdit}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={saveEdit}
              disabled={loadingYaml || savingEdit || !editYaml.trim()}
            >
              {savingEdit ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(budgetFor)}
        onOpenChange={(open) => {
          if (!open) {
            setBudgetFor(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("budgetTitle", { name: budgetFor?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("budgetHint")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="text-[11px] text-zinc-400">
              {t("budgetDaily")}
              <Input
                type="number"
                min={0}
                step="0.01"
                value={dailyCost}
                aria-label={t("budgetDaily")}
                onChange={(event) => setDailyCost(event.target.value)}
                className="mt-1 h-8 text-[11px]"
              />
            </div>
            <div className="text-[11px] text-zinc-400">
              {t("budgetItems")}
              <Input
                type="number"
                min={1}
                max={100}
                step={1}
                value={maxItems}
                aria-label={t("budgetItems")}
                onChange={(event) => setMaxItems(event.target.value)}
                className="mt-1 h-8 text-[11px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBudgetFor(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={saveBudget} disabled={savingBudget}>
              {savingBudget ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(retiring)}
        onOpenChange={(open) => {
          if (!open) {
            setRetiring(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("retireTitle", { name: retiring?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("retireHint")}</DialogDescription>
          </DialogHeader>
          <div className="text-[11px] text-zinc-400">
            {t("retireReason")}
            <Textarea
              value={retireReason}
              aria-label={t("retireReason")}
              onChange={(event) => setRetireReason(event.target.value)}
              rows={2}
              className="mt-1 text-[11px]"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRetiring(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={retire}
              disabled={retireBusy}
            >
              {retireBusy ? t("retiring") : t("retireConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
