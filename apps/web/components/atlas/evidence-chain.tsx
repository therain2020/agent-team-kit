"use client";

import { Badge } from "@/components/ui/badge";
import type { AtlasEvidence, AtlasEvidenceArtifact } from "@/lib/atlas";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { minuteOfDay, truncateLabel } from "./theme";

/**
 * Evidence-chain drill-down (#140): for the focused artifact, show who
 * produced it, which artifacts it consumed, who consumed it, and which gates
 * judged it. Focus moves through the URL (`?artifact=artifactId@version`) so
 * the server recomputes the chain; nothing is fetched client-side.
 */
export function EvidenceChain({
  evidence,
  runId,
}: {
  evidence: AtlasEvidence;
  runId: string;
}) {
  const t = useTranslations("atlas");
  const focus =
    evidence.artifacts.find((artifact) => artifact.key === evidence.focus) ??
    evidence.artifacts[0] ??
    null;

  const sourceLabel =
    evidence.source === "edges"
      ? t("evidenceSourceEdges")
      : evidence.source === "manifest"
        ? t("evidenceSourceManifest")
        : evidence.source === "demo"
          ? t("evidenceSourceDemo")
          : t("evidenceEmpty");

  return (
    <section className="border border-px-line bg-px-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-px-line bg-px-panel2 px-3 py-2">
        <div>
          <h2 className="font-mono text-[11px] font-bold tracking-[0.16em] text-px-strong uppercase">
            {t("evidenceTitle")}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-px-muted">
            {t("evidenceHint")}
          </p>
        </div>
        <Badge variant={evidence.source === "edges" ? "success" : "default"}>
          {sourceLabel}
        </Badge>
      </header>

      {evidence.artifacts.length === 0 ? (
        <p className="px-3 py-3 font-mono text-[11px] text-px-muted">
          {t("evidenceEmpty")}
        </p>
      ) : (
        <div className="px-3 py-2.5">
          <ul className="mb-3 flex flex-wrap gap-1">
            {evidence.artifacts.slice(0, 10).map((artifact) => (
              <li key={artifact.key}>
                <Link
                  href={artifactHref(runId, artifact.key)}
                  aria-current={
                    artifact.key === focus?.key ? "true" : undefined
                  }
                  className={cn(
                    "block max-w-44 truncate border px-1.5 py-1 font-mono text-[10px]",
                    artifact.key === focus?.key
                      ? "border-px-accent bg-px-hi text-px-strong"
                      : "border-px-line2 text-px-muted hover:border-px-line3 hover:text-px-text",
                  )}
                >
                  {truncateLabel(artifact.stageName ?? artifact.artifactId, 22)}
                  <span className="text-px-faint">@v{artifact.version}</span>
                </Link>
              </li>
            ))}
          </ul>

          {focus ? <FocusCard artifact={focus} runId={runId} /> : null}
        </div>
      )}
    </section>
  );
}

function FocusCard({
  artifact,
  runId,
}: {
  artifact: AtlasEvidenceArtifact;
  runId: string;
}) {
  const t = useTranslations("atlas");
  return (
    <div className="border border-px-line bg-px-ink/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-px-strong">
          {artifact.stageName ?? artifact.artifactId}
          <span className="text-px-faint">@v{artifact.version}</span>
        </span>
        {artifact.agentId ? (
          <span className="font-mono text-[10px] text-px-muted">
            {artifact.agentId}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-px-faint">
          {minuteOfDay(artifact.createdAt)}
        </span>
      </div>

      <div className="mt-2 grid gap-2">
        <ChainColumn
          title={t("evidenceProducedBy")}
          rows={
            artifact.inputs.length > 0
              ? artifact.inputs.map((input) => ({
                  key: input.key,
                  label: input.stageName ?? input.artifactId,
                  version: input.artifactVersion,
                }))
              : [{ key: "none", label: t("evidenceRoot"), version: 0 }]
          }
          runId={runId}
          empty={false}
        />
        <ChainColumn
          title={t("evidenceConsumedBy")}
          rows={artifact.consumers.map((consumer) => ({
            key: consumer.key,
            label: consumer.stageName ?? consumer.artifactId,
            version: consumer.artifactVersion,
          }))}
          runId={runId}
          empty={artifact.consumers.length === 0}
        />
        <div>
          <p className="font-mono text-[9px] tracking-[0.14em] text-px-faint uppercase">
            {t("evidenceGates")}
          </p>
          {artifact.gates.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {artifact.gates.map((gate) => (
                <li key={`${gate.stageId}-${gate.pass}`}>
                  <span
                    className={cn(
                      "inline-block border px-1.5 py-0.5 font-mono text-[10px]",
                      gate.pass
                        ? "border-emerald-700 bg-px-ok-bg text-emerald-300"
                        : "border-red-700 bg-px-danger-bg text-red-300",
                    )}
                  >
                    {gate.stageName} · {gate.pass ? t("pass") : t("fail")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 font-mono text-[10px] text-px-faint">
              {t("evidenceNoGate")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ChainColumn({
  title,
  rows,
  runId,
  empty,
}: {
  title: string;
  rows: Array<{ key: string; label: string; version: number }>;
  runId: string;
  empty: boolean;
}) {
  const t = useTranslations("atlas");
  return (
    <div>
      <p className="font-mono text-[9px] tracking-[0.14em] text-px-faint uppercase">
        {title}
      </p>
      {empty ? (
        <p className="mt-1 font-mono text-[10px] text-px-faint">
          {t("evidenceNone")}
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {rows.map((row) => (
            <li key={row.key}>
              {row.version > 0 ? (
                <Link
                  href={artifactHref(runId, row.key)}
                  className="inline-block max-w-48 truncate border border-px-line2 px-1.5 py-0.5 font-mono text-[10px] text-px-text hover:border-px-accent hover:text-px-accent-hi"
                >
                  {truncateLabel(row.label, 24)}
                  <span className="text-px-faint">@v{row.version}</span>
                </Link>
              ) : (
                <span className="inline-block font-mono text-[10px] text-px-faint">
                  {row.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function artifactHref(runId: string, key: string): string {
  return `/atlas?runId=${encodeURIComponent(runId)}&artifact=${encodeURIComponent(key)}`;
}
