"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SourceProposal, SourceRetirementProposal } from "@kit/source";
import { Archive, Check, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const RISK_VARIANT: Record<string, "success" | "warning" | "danger"> = {
  low: "success",
  medium: "warning",
  high: "danger",
};

const STATUS_VARIANT: Record<
  string,
  "success" | "warning" | "danger" | "outline"
> = {
  proposed: "outline",
  validated: "success",
  approved: "success",
  applied: "success",
  rejected: "danger",
};

interface DraftResponse {
  values?: {
    authored?: { yaml: string; endpoint: string };
  };
  model?: "live" | "heuristic";
  error?: string;
}

/**
 * Source self-manufacture panel (issue #131, 98 I-5, D-64).
 *
 * Intent → declarative draft → gate → observer edit → explicit approval →
 * install. AI drafts never install themselves; low-yield retirement proposals
 * are reviewed here too and retirement keeps manifests and history.
 */
export function SourceProposals({
  initialProposals,
  initialRetirements,
}: {
  initialProposals: SourceProposal[];
  initialRetirements: SourceRetirementProposal[];
}) {
  const t = useTranslations("sourcesProposals");
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [yaml, setYaml] = useState("");
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<SourceProposal | null>(null);
  const [proposals, setProposals] = useState(initialProposals);
  const [retirements, setRetirements] = useState(initialRetirements);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
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
      const payload = (await response.json()) as DraftResponse;
      const authored = payload.values?.authored;
      if (!response.ok || !authored) {
        throw new Error(payload.error ?? t("draftFailed"));
      }
      setYaml(authored.yaml);
      setModel(payload.model === "live" ? "live" : "heuristic");
    } catch (problem) {
      const text =
        problem instanceof Error ? problem.message : t("draftFailed");
      setError(text);
      toast.error(text);
    } finally {
      setDrafting(false);
    }
  }

  async function saveProposal() {
    if (!intent.trim() || !yaml.trim()) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/sources/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: intent.trim(), yaml, model }),
      });
      const payload = (await response.json()) as SourceProposal & {
        error?: string;
      };
      if (!response.ok || !payload.id) {
        throw new Error(payload.error ?? t("proposalFailed"));
      }
      setProposals([
        payload,
        ...proposals.filter((item) => item.id !== payload.id),
      ]);
      setSelected(payload);
    } catch (problem) {
      const text =
        problem instanceof Error ? problem.message : t("proposalFailed");
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function revise() {
    if (!selected) {
      return;
    }
    setBusy("revise");
    try {
      const response = await fetch(
        `/api/sources/proposals/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ yaml }),
        },
      );
      const payload = (await response.json()) as SourceProposal & {
        error?: string;
      };
      if (!response.ok || !payload.id) {
        throw new Error(payload.error ?? t("proposalFailed"));
      }
      setSelected(payload);
      setProposals(
        proposals.map((item) => (item.id === payload.id ? payload : item)),
      );
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("proposalFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    if (!selected) {
      return;
    }
    setBusy("install");
    try {
      const response = await fetch(
        `/api/sources/proposals/${encodeURIComponent(selected.id)}/install`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved: true, yaml }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        name?: string;
        proposal?: SourceProposal;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("installFailed"));
      }
      toast.success(t("installDone", { name: payload.name ?? selected.name }));
      setSelected(payload.proposal ?? selected);
      const applied = payload.proposal;
      if (applied) {
        setProposals(
          proposals.map((item) => (item.id === applied.id ? applied : item)),
        );
      }
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("installFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  async function retire(proposal: SourceRetirementProposal) {
    setBusy(proposal.id);
    try {
      const response = await fetch(
        `/api/sources/${encodeURIComponent(proposal.sourceId)}/retire`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposalId: proposal.id,
            reason: proposal.reason,
            evidence: proposal.evidence,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("retireFailed"));
      }
      toast.success(t("retireDone", { name: proposal.sourceId }));
      setRetirements(retirements.filter((item) => item.id !== proposal.id));
      router.refresh();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("retireFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-border bg-card/60 p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Sparkles className="size-4 text-violet-400" />
          {t("title")}
        </h2>
        <p className="mb-2 text-[10px] text-zinc-500">{t("hint")}</p>
        <Textarea
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder={t("intentPlaceholder")}
          rows={2}
          className="text-[11px]"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button onClick={draft} disabled={drafting || !intent.trim()}>
            <Sparkles className={cn("size-3.5", drafting && "animate-pulse")} />
            {drafting ? t("drafting") : t("draft")}
          </Button>
          {yaml ? (
            <Button
              variant="secondary"
              onClick={saveProposal}
              disabled={saving}
            >
              {saving ? t("saving") : t("saveProposal")}
            </Button>
          ) : null}
        </div>

        {yaml ? (
          <div className="mt-3 space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("yamlLabel")}
            </p>
            <Textarea
              value={yaml}
              onChange={(event) => setYaml(event.target.value)}
              rows={12}
              className="font-mono text-[11px]"
            />
            <p className="text-[10px] text-zinc-500">{t("yamlHint")}</p>
          </div>
        ) : null}

        {selected ? (
          <div className="mt-3 space-y-2 rounded-lg border border-border bg-zinc-950/40 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-zinc-200">
                {selected.name}
              </span>
              <Badge variant={STATUS_VARIANT[selected.status] ?? "outline"}>
                {t(`status${selected.status}`)}
              </Badge>
              <Badge variant={RISK_VARIANT[selected.risk.level] ?? "warning"}>
                {t(`risk${selected.risk.level}`)}
              </Badge>
              <Badge variant="outline">{selected.model}</Badge>
            </div>
            <p className="text-[10px] text-zinc-400">{selected.rationale}</p>
            {selected.issues.length > 0 ? (
              <ul className="space-y-0.5 text-[10px] text-red-300">
                {selected.issues.map((issue) => (
                  <li key={`${issue.code}:${issue.path}`}>
                    {issue.code} {issue.path}: {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-emerald-300/80">{t("noIssues")}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={revise}
                disabled={busy !== null}
              >
                <RefreshCw className="size-3.5" />
                {t("revise")}
              </Button>
              <Button
                size="sm"
                onClick={install}
                disabled={
                  busy !== null ||
                  selected.status === "applied" ||
                  selected.issues.length > 0
                }
              >
                <Check className="size-3.5" />
                {busy === "install" ? t("installing") : t("approveInstall")}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="mt-2 whitespace-pre-wrap text-[10px] text-red-300">
            {error}
          </p>
        ) : null}
      </section>

      {proposals.length > 0 ? (
        <section className="rounded-xl border border-border bg-card/60 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-200">
            {t("listTitle")}
          </h2>
          <ul className="space-y-1.5">
            {proposals.map((proposal) => (
              <li key={proposal.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(proposal);
                    setYaml(proposal.yaml);
                  }}
                  className="flex w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-zinc-950/30 px-3 py-2 text-left hover:border-zinc-600"
                >
                  <span className="font-mono text-xs text-zinc-200">
                    {proposal.name}
                  </span>
                  <Badge variant={STATUS_VARIANT[proposal.status] ?? "outline"}>
                    {t(`status${proposal.status}`)}
                  </Badge>
                  <Badge
                    variant={RISK_VARIANT[proposal.risk.level] ?? "warning"}
                  >
                    {t(`risk${proposal.risk.level}`)}
                  </Badge>
                  <span className="text-[10px] text-zinc-500">
                    {proposal.trust?.signature ?? "missing"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-zinc-500">
          {t("empty")}
        </p>
      )}

      <section className="rounded-xl border border-border bg-card/60 p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-zinc-200">
          <Archive className="size-4 text-amber-400" />
          {t("retirementsTitle")}
        </h2>
        <p className="mb-2 text-[10px] text-zinc-500">{t("retirementsHint")}</p>
        {retirements.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-zinc-500">
            {t("retirementEmpty")}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {retirements.map((proposal) => (
              <li
                key={proposal.id}
                className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-zinc-100">
                    {proposal.sourceId}
                  </span>
                  <Badge variant="warning">{t("retirementBadge")}</Badge>
                </div>
                <p className="mt-1 text-[10px] text-amber-200/80">
                  {proposal.reason}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  {t("retirementEvidence", {
                    runs: proposal.evidence.runs,
                    events: proposal.evidence.eventsCreated,
                    items: proposal.evidence.itemsCollected,
                    ratio: Math.round(proposal.evidence.eventRatio * 100),
                  })}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => retire(proposal)}
                  disabled={busy !== null}
                >
                  <Archive className="size-3.5" />
                  {busy === proposal.id ? t("retiring") : t("retire")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
