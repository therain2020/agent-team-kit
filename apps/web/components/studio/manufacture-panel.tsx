"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ManufactureProposal } from "@kit/job";
import { CheckCircle2, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

type Kind = "agent" | "manager" | "workflow" | "pipeline" | "component";

const KINDS: Kind[] = ["agent", "manager", "workflow", "pipeline", "component"];
const COMPONENT_KINDS = ["agent", "workflow", "toolpack", "skillpack"] as const;

interface ComponentOption {
  kind: (typeof COMPONENT_KINDS)[number];
  id: string;
  version: string | null;
  bound: boolean;
}

/**
 * Studio manufacturing surface (issue #132, plan 98 §3.4, D-64 C-6c).
 *
 * First screen is only the object (kind + id / component) and one sentence.
 * Everything else — rationale, warnings, risk, dry-run preview — appears in the
 * review card. Nothing reaches the pack until the operator accepts, and accept
 * is gated on a successful dry-run plus explicit approval for permission
 * expansion.
 */
export function ManufacturePanel({ dirName }: { dirName: string }) {
  const t = useTranslations("manufacture");
  const [kind, setKind] = useState<Kind>("agent");
  const [assetId, setAssetId] = useState("");
  const [intent, setIntent] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [allowCommand, setAllowCommand] = useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<
    "draft" | "dry-run" | "accept" | "rollback" | null
  >(null);
  const [proposal, setProposal] = useState<ManufactureProposal | null>(null);
  const [proposals, setProposals] = useState<ManufactureProposal[]>([]);
  const [components, setComponents] = useState<ComponentOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/manufacture`,
      );
      const payload = (await response.json()) as {
        proposals?: ManufactureProposal[];
        components?: ComponentOption[];
      };
      setProposals(payload.proposals ?? []);
      setComponents(payload.components ?? []);
    } catch {
      // The draft action still works; the list is a convenience.
    }
  }, [dirName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function call(
    action: "draft" | "dry-run" | "accept" | "rollback",
    body: Record<string, unknown>,
  ) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/manufacture`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        },
      );
      const payload = (await response.json()) as ManufactureProposal & {
        error?: string;
        issues?: Array<{ code: string; message: string }>;
      };
      if (!response.ok) {
        const details = payload.issues
          ?.map((issue) => issue.message)
          .join("; ");
        throw new Error(
          [payload.error ?? t("failed"), details].filter(Boolean).join(" — "),
        );
      }
      setProposal(payload);
      setApproved(false);
      await refresh();
      if (action === "accept") {
        toast.success(t("accepted"));
      } else if (action === "rollback") {
        toast.success(t("rolledBack"));
      } else if (action === "dry-run") {
        toast.success(payload.dryRun?.ok ? t("dryRunOk") : t("dryRunFailed"));
      }
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setBusy(null);
    }
  }

  function draft() {
    if (!intent.trim()) {
      toast.error(t("intentRequired"));
      return;
    }
    const componentIds = picked
      .map((key) => {
        const [componentKind, id] = key.split("/");
        return { kind: componentKind ?? "", id: id ?? "" };
      })
      .filter((component) =>
        (COMPONENT_KINDS as readonly string[]).includes(component.kind),
      );
    void call("draft", {
      kind,
      intent: intent.trim(),
      ...(kind !== "manager" && assetId.trim()
        ? { assetId: assetId.trim() }
        : {}),
      ...(kind === "component" ? { componentIds, allowCommand } : {}),
    });
  }

  function dryRun() {
    if (proposal) {
      void call("dry-run", { proposalId: proposal.id });
    }
  }

  function accept() {
    if (proposal) {
      void call("accept", {
        proposalId: proposal.id,
        approved,
      });
    }
  }

  function rollback(target: ManufactureProposal) {
    if (!window.confirm(t("confirmRollback", { id: target.assetId }))) {
      return;
    }
    setProposal(target);
    void call("rollback", { proposalId: target.id });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 text-emerald-300" />
          <div>
            <h3 className="text-sm font-medium text-zinc-100">{t("title")}</h3>
            <p className="mt-1 text-[11px] text-zinc-500">{t("hint")}</p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
          <label className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
            <span>{t("kind")}</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as Kind);
                setProposal(null);
                setPicked([]);
              }}
              className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs normal-case tracking-normal text-zinc-200"
            >
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`kinds.${value}`)}
                </option>
              ))}
            </select>
          </label>
          {kind !== "manager" && kind !== "component" ? (
            <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
              <span className="block">{t("assetId")}</span>
              <Input
                value={assetId}
                onChange={(event) => setAssetId(event.target.value)}
                placeholder={t("assetIdPlaceholder")}
                aria-label={t("assetId")}
                className="h-9 font-mono text-xs"
              />
            </div>
          ) : null}
        </div>

        {kind === "component" ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("components")}
            </p>
            {components.length === 0 ? (
              <p className="text-[11px] text-amber-300/80">
                {t("noComponents")}
              </p>
            ) : (
              <div className="grid gap-1 sm:grid-cols-2">
                {components.map((component) => {
                  const key = `${component.kind}/${component.id}`;
                  const checked = picked.includes(key);
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-[11px] text-zinc-300"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPicked((current) =>
                            checked
                              ? current.filter((item) => item !== key)
                              : [...current, key],
                          )
                        }
                        className="size-3.5 accent-emerald-500"
                      />
                      <span className="font-mono">{key}</span>
                      <span className="ml-auto text-[10px] text-zinc-600">
                        {component.version ?? "0.1.0"}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              <input
                type="checkbox"
                checked={allowCommand}
                onChange={(event) => setAllowCommand(event.target.checked)}
                className="size-3.5 accent-amber-500"
              />
              {t("allowCommand")}
            </label>
          </div>
        ) : null}

        <Textarea
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder={t("placeholder")}
          className="min-h-16 text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={draft}
            disabled={busy !== null || !intent.trim()}
          >
            <Sparkles className="size-3.5" />
            {busy === "draft" ? t("drafting") : t("draft")}
          </Button>
          <span className="text-[10px] text-zinc-600">{t("draftHint")}</span>
        </div>
      </div>

      {error ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {error}
        </pre>
      ) : null}

      {proposal ? (
        <ProposalReview
          proposal={proposal}
          approved={approved}
          onApproved={setApproved}
          busy={busy}
          onDryRun={dryRun}
          onAccept={accept}
          onRollback={() => rollback(proposal)}
        />
      ) : null}

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">
          {t("recent")}
        </p>
        {proposals.length === 0 ? (
          <p className="text-[11px] text-zinc-600">{t("noProposals")}</p>
        ) : (
          <div className="space-y-1">
            {proposals.slice(0, 8).map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[11px]",
                  item.id === proposal?.id && "bg-zinc-900/60",
                )}
              >
                <StatusBadge status={item.status} />
                <span className="font-mono text-zinc-300">
                  {item.kind} · {item.assetId}
                </span>
                <span className="truncate text-zinc-500">{item.intent}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setProposal(item)}
                  >
                    {t("open")}
                  </Button>
                  {item.status === "accepted" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => rollback(item)}
                    >
                      <Undo2 className="size-3.5" />
                      {t("rollback")}
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProposalReview({
  proposal,
  approved,
  onApproved,
  busy,
  onDryRun,
  onAccept,
  onRollback,
}: {
  proposal: ManufactureProposal;
  approved: boolean;
  onApproved: (value: boolean) => void;
  busy: string | null;
  onDryRun: () => void;
  onAccept: () => void;
  onRollback: () => void;
}) {
  const t = useTranslations("manufacture");
  const dryRun = proposal.dryRun;
  const canAccept =
    proposal.issues.length === 0 &&
    dryRun?.ok === true &&
    proposal.status !== "accepted" &&
    proposal.status !== "rolled-back" &&
    (!proposal.risk.requiresApproval || approved) &&
    busy === null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={proposal.status} />
        <Badge variant={proposal.model === "live" ? "success" : "outline"}>
          {proposal.model === "live" ? t("modelLive") : "model: heuristic"}
        </Badge>
        <Badge
          variant={
            proposal.risk.level === "high"
              ? "danger"
              : proposal.risk.level === "medium"
                ? "warning"
                : "outline"
          }
        >
          {t(`risk.${proposal.risk.level}`)}
        </Badge>
        <span className="font-mono text-[10px] text-zinc-500">
          {proposal.kind} · {proposal.assetId}
        </span>
      </div>

      <p className="text-[11px] text-zinc-400">{proposal.rationale}</p>

      {proposal.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
          {proposal.warnings.map((warning) => (
            <li key={warning}>· {warning}</li>
          ))}
        </ul>
      ) : null}

      {proposal.issues.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-200">
          {proposal.issues.map((issue) => (
            <li key={`${issue.code}:${issue.path}:${issue.message}`}>
              · {issue.code} {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <DraftSummary proposal={proposal} />

      {proposal.risk.requiresApproval ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
          <input
            type="checkbox"
            checked={approved}
            onChange={(event) => onApproved(event.target.checked)}
            className="mt-0.5 size-3.5 accent-amber-500"
          />
          <span>
            {t("approvalRequired")}
            {proposal.risk.reasons.length > 0
              ? ` (${proposal.risk.reasons.join("; ")})`
              : ""}
          </span>
        </label>
      ) : null}

      {dryRun ? (
        <div className="space-y-2 rounded-md border border-border bg-zinc-950/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-zinc-200">
              {t("dryRunTitle")}
            </span>
            <Badge variant={dryRun.ok ? "success" : "danger"}>
              {dryRun.ok ? t("dryRunOk") : t("dryRunFailed")}
            </Badge>
          </div>
          <ul className="space-y-1 text-[10px]">
            {dryRun.steps.map((step) => (
              <li key={step.id} className="flex gap-2">
                <span className={step.ok ? "text-emerald-300" : "text-red-300"}>
                  {step.ok ? "✓" : "✕"}
                </span>
                <span className="font-mono text-zinc-400">{step.id}</span>
                <span className="text-zinc-500">{step.detail}</span>
              </li>
            ))}
          </ul>
          {dryRun.preview.length > 0 ? (
            <ul className="space-y-1 text-[10px] text-zinc-500">
              {dryRun.preview.map((file) => (
                <li key={file.path} className="font-mono">
                  {file.path} · {file.bytes} B
                </li>
              ))}
            </ul>
          ) : null}
          {dryRun.warnings.length > 0 ? (
            <ul className="space-y-1 text-[10px] text-amber-200/80">
              {dryRun.warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {proposal.acceptance ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[10px] text-emerald-200">
          <p>
            {t("acceptedAt", { at: proposal.acceptance.at })} ·{" "}
            {proposal.acceptance.provenance.version} ·{" "}
            <span className="font-mono">
              {proposal.acceptance.provenance.source.sha256.slice(0, 12)}
            </span>
          </p>
          <p className="mt-1 font-mono text-zinc-400">
            {proposal.acceptance.files.join(", ")}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onDryRun}
          disabled={busy !== null || proposal.issues.length > 0}
        >
          {busy === "dry-run" ? t("dryRunning") : t("dryRun")}
        </Button>
        <Button size="sm" onClick={onAccept} disabled={!canAccept}>
          <CheckCircle2 className="size-3.5" />
          {busy === "accept" ? t("accepting") : t("accept")}
        </Button>
        {proposal.status === "accepted" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onRollback}
            disabled={busy !== null}
          >
            <RotateCcw className="size-3.5" />
            {t("rollback")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DraftSummary({ proposal }: { proposal: ManufactureProposal }) {
  const t = useTranslations("manufacture");
  const draft = proposal.draft;
  if (draft.type === "agent" || draft.type === "manager") {
    return (
      <dl className="grid gap-x-3 gap-y-1 text-[11px] sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="text-zinc-500">{t("description")}</dt>
          <dd className="text-zinc-200">{draft.description}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("model")}</dt>
          <dd className="font-mono text-zinc-300">{draft.model}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("role")}</dt>
          <dd className="font-mono text-zinc-300">{draft.role}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("tools")}</dt>
          <dd className="font-mono text-zinc-300">
            {draft.tools.join(", ") || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("skills")}</dt>
          <dd className="font-mono text-zinc-300">
            {draft.skills.join(", ") || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("network")}</dt>
          <dd className="font-mono text-zinc-300">
            {draft.permissions.network}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">{t("filesystem")}</dt>
          <dd className="font-mono text-zinc-300">
            {draft.permissions.filesystem}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-zinc-500">{t("instructions")}</dt>
          <dd>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-zinc-300">
              {draft.instructions}
            </pre>
          </dd>
        </div>
      </dl>
    );
  }
  if (draft.type === "workflow") {
    return (
      <div className="space-y-1">
        {draft.stages.map((stage) => (
          <div
            key={stage.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2.5 py-1.5 text-[10px]"
          >
            <span className="font-mono text-zinc-300">{stage.id}</span>
            <span className="rounded border border-border px-1 uppercase text-zinc-500">
              {stage.type}
            </span>
            <span className="font-mono text-zinc-400">
              {stage.agent ?? stage.coder ?? "—"}
            </span>
            <span className="ml-auto text-zinc-500">
              {stage.depends.length > 0
                ? `${t("dependsOn")}: ${stage.depends.join(", ")}`
                : t("entry")}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (draft.type === "pipeline") {
    return (
      <div className="space-y-1">
        {draft.values.stages.map((stage) => (
          <div
            key={stage.id}
            className="flex flex-wrap items-center gap-x-2 rounded-md border border-border px-2.5 py-1.5 text-[10px]"
          >
            <span className="font-mono text-zinc-300">{stage.id}</span>
            <span className="rounded border border-border px-1 uppercase text-zinc-500">
              {stage.type}
            </span>
            <span className="text-zinc-500">
              {stage.inputs.join(", ")} → {stage.outputs.join(", ")}
            </span>
          </div>
        ))}
        {draft.values.issues.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[10px] text-red-200">
            {draft.values.issues.map((issue) => (
              <li key={`${issue.code}:${issue.path}`}>
                · {issue.code} {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {draft.components.map((component) => (
        <div
          key={`${component.kind}/${component.id}`}
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[10px]"
        >
          <span className="font-mono text-zinc-300">
            {component.kind}/{component.id}
          </span>
          <span className="ml-auto text-zinc-500">{t("componentSource")}</span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: ManufactureProposal["status"] }) {
  const t = useTranslations("manufacture");
  const variant =
    status === "accepted"
      ? "success"
      : status === "rejected" || status === "rolled-back"
        ? "danger"
        : status === "dry-run"
          ? "violet"
          : "outline";
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}
