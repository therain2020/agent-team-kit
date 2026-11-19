"use client";

import { Badge } from "@/components/ui/badge";
import type { StageDetailData } from "@/lib/stage-detail";
import { cn, formatNumber } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Play,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface StageTarget {
  /** Agent whose station was opened; shown in the drawer header. */
  agentId: string;
  runId: string | null;
  /** `${runId}:${stageName}` from the world projection. */
  stageId: string | null;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: StageDetailData };

/**
 * Stage drawer for the pixel factory (issue #156 ③ 环节详情).
 *
 * Opens immediately from floor selection and loads the stage payload from
 * `/api/office/stage`; every section has an explicit empty state so a missing
 * dossier, prompt or gate never renders as a blank panel.
 */
export function StageDrawer({
  packDir,
  target,
  onClose,
  onRerun,
}: {
  packDir: string;
  target: StageTarget | null;
  onClose: () => void;
  onRerun: (workflowHint: string | null) => void;
}) {
  const t = useTranslations("stageDetail");
  const common = useTranslations("common");
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const load = useCallback(
    async (runId: string, stageId: string | null, signal: AbortSignal) => {
      setState({ kind: "loading" });
      const params = new URLSearchParams({ pack: packDir, runId });
      if (stageId) {
        params.set("stageId", stageId);
      }
      try {
        const response = await fetch(`/api/office/stage?${params.toString()}`, {
          signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as StageDetailData;
        setState({ kind: "ready", data });
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "fetch failed",
        });
      }
    },
    [packDir],
  );

  useEffect(() => {
    if (!target) {
      setState({ kind: "idle" });
      return;
    }
    if (!target.runId) {
      return;
    }
    const controller = new AbortController();
    void load(target.runId, target.stageId, controller.signal);
    return () => controller.abort();
  }, [target, load]);

  useEffect(() => {
    if (!target) {
      previousFocus.current?.focus?.();
      previousFocus.current = null;
      return;
    }
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
  }, [target]);

  // Escape closes the drawer; the floor suspends its own handler while open so
  // one press never both closes and unlocks.
  useEffect(() => {
    if (!target) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) {
    return null;
  }

  const data = state.kind === "ready" ? state.data : null;
  const stageName =
    data?.stageName ??
    (target.stageId
      ? (target.stageId.split(":").pop() ?? target.stageId)
      : null);

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={common("close")}
        onClick={onClose}
        className="absolute inset-0 bg-black/65"
      />
      <dialog
        open
        aria-modal="true"
        aria-label={t("title")}
        className="absolute inset-y-0 right-0 m-0 flex h-full max-h-none w-full max-w-xl flex-col overflow-hidden border-0 border-l-2 border-px-line3 bg-px-panel p-0 text-inherit shadow-[var(--px-shadow-lg)]"
      >
        <header className="flex items-start justify-between gap-3 border-b border-px-line bg-px-panel2 px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-px-faint">
              {t("title")}
            </p>
            <h2 className="truncate font-mono text-sm font-bold text-px-strong">
              {stageName ?? t("noStage")}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-mono">
                {target.agentId}
              </Badge>
              {data?.stageStatus ? (
                <Badge variant={statusVariant(data.stageStatus)}>
                  {data.stageStatus}
                </Badge>
              ) : null}
              {data?.runStatus ? (
                <Badge variant="outline" className="font-mono">
                  {t("runStatus", { status: data.runStatus })}
                </Badge>
              ) : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={common("close")}
            className="rounded-none border border-px-line2 p-1 text-px-muted transition-colors hover:border-px-line3 hover:text-px-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-px-cream"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {!target.runId ? (
            <EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />
          ) : null}

          {target.runId && state.kind === "loading" ? (
            <p className="flex items-center gap-2 border border-px-line bg-px-panel2 px-3 py-4 text-xs text-px-muted">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {t("loading")}
            </p>
          ) : null}

          {target.runId && state.kind === "error" ? (
            <div className="border border-px-danger/40 bg-px-danger-bg px-3 py-3 text-xs text-red-200">
              <p className="flex items-center gap-2">
                <AlertTriangle className="size-3.5" />
                {t("loadFailed")}
              </p>
              <p className="mt-1 font-mono text-[10px] text-red-300/80">
                {state.message}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (target.runId) {
                    const controller = new AbortController();
                    void load(target.runId, target.stageId, controller.signal);
                  }
                }}
                className="mt-2 border border-px-line2 px-2 py-1 font-mono text-[10px] uppercase text-px-text hover:border-px-line3"
              >
                {t("retry")}
              </button>
            </div>
          ) : null}

          {data && !data.found ? (
            <EmptyState
              title={t("runMissingTitle")}
              hint={t("runMissingHint")}
            />
          ) : null}

          {data?.found ? (
            <>
              <Section
                icon={<ScrollText className="size-3.5" />}
                title={t("whatItDoes")}
              >
                {data.definition ? (
                  <DefinitionBlock data={data} />
                ) : (
                  <p className="text-[11px] text-px-muted">
                    {t("noDefinition")}
                  </p>
                )}
              </Section>

              <PromptBlock prompt={data.prompt} />

              <Section
                icon={<FileText className="size-3.5" />}
                title={t("result")}
              >
                <ResultBlock data={data} locale={locale} />
              </Section>

              <Section
                icon={<ShieldCheck className="size-3.5" />}
                title={t("gates")}
              >
                {data.gates.length === 0 ? (
                  <p className="text-[11px] text-px-muted">{t("noGates")}</p>
                ) : (
                  <ul className="space-y-1">
                    {data.gates.map((gate) => (
                      <li
                        key={`${gate.attempt}:${gate.summary}`}
                        className="flex flex-wrap items-center gap-1.5 border border-px-line px-2 py-1.5 font-mono text-[10px]"
                      >
                        {gate.pass ? (
                          <CheckCircle2 className="size-3 text-emerald-300" />
                        ) : (
                          <XCircle className="size-3 text-red-300" />
                        )}
                        <span className="text-px-text">
                          {t("attempt", { attempt: gate.attempt })}
                        </span>
                        {Object.entries(gate.scores)
                          .slice(0, 4)
                          .map(([key, value]) => (
                            <span
                              key={key}
                              className="border border-px-line2 px-1 text-px-muted"
                            >
                              {key} {value}
                              {gate.thresholds[key] !== undefined
                                ? ` / ${gate.thresholds[key]}`
                                : ""}
                            </span>
                          ))}
                        {gate.summary ? (
                          <span className="w-full truncate text-px-faint">
                            {gate.summary}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                icon={<Play className="size-3.5" />}
                title={t("artifacts")}
              >
                {data.artifacts.length === 0 ? (
                  <p className="text-[11px] text-px-muted">
                    {t("noArtifacts")}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {data.artifacts.map((artifact) => (
                      <li key={`${artifact.artifactId}:${artifact.version}`}>
                        <Link
                          href={`/world?run=${encodeURIComponent(data.runId)}&tab=artifacts&artifact=${encodeURIComponent(`${artifact.artifactId}:${artifact.version}`)}`}
                          className="flex items-center gap-1 border border-px-line px-1.5 py-0.5 font-mono text-[10px] text-px-muted hover:border-px-line3 hover:text-px-text"
                        >
                          <FileText className="size-3" />
                          {artifact.artifactId}
                          <span className="text-px-faint">
                            v{artifact.version}
                          </span>
                          <span className="text-px-faint">{artifact.kind}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          ) : null}
        </div>

        <footer className="flex flex-wrap items-center gap-1.5 border-t border-px-line bg-px-panel2 px-4 py-2.5">
          {target.runId ? (
            <Link
              href={`/world?run=${encodeURIComponent(target.runId)}&tab=timeline`}
              className="flex items-center gap-1 border border-px-line2 px-2 py-1 font-mono text-[10px] uppercase text-px-text hover:border-px-line3"
            >
              <ExternalLink className="size-3" />
              {t("openRun")}
            </Link>
          ) : null}
          {data?.approval ? (
            <Link
              href={`/approvals?request=${encodeURIComponent(data.approval.requestId)}`}
              className="flex items-center gap-1 border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] uppercase text-amber-200 hover:border-amber-400"
            >
              <Inbox className="size-3" />
              {t("openApproval")}
            </Link>
          ) : null}
          {target.runId ? (
            <button
              type="button"
              onClick={() => onRerun(data?.definition?.id ?? stageName)}
              className="flex items-center gap-1 border border-px-line2 px-2 py-1 font-mono text-[10px] uppercase text-px-text hover:border-px-line3"
            >
              <RotateCcw className="size-3" />
              {t("rerun")}
            </button>
          ) : null}
        </footer>
      </dialog>
    </div>
  );
}

function DefinitionBlock({ data }: { data: StageDetailData }) {
  const t = useTranslations("stageDetail");
  const definition = data.definition;
  if (!definition) {
    return null;
  }
  return (
    <div className="space-y-2">
      {definition.goal ? (
        <p className="border-l-2 border-px-line3 pl-2 text-[11px] leading-relaxed text-px-text">
          {definition.goal}
        </p>
      ) : null}
      {definition.acceptance ? (
        <p className="text-[10px] text-px-muted">
          <span className="uppercase tracking-wider text-px-faint">
            {t("acceptance")}
          </span>{" "}
          {definition.acceptance}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1 font-mono text-[10px]">
        <Chip label={t("type")} value={definition.type} />
        {definition.agent ? (
          <Chip label={t("agent")} value={definition.agent} />
        ) : null}
        {definition.coder ? (
          <Chip label={t("coder")} value={definition.coder} />
        ) : null}
        {definition.timeout ? (
          <Chip label={t("timeout")} value={definition.timeout} />
        ) : null}
        {definition.gate ? (
          <Chip label={t("gate")} value={definition.gate} />
        ) : null}
      </div>
      {data.agent ? (
        <p className="text-[10px] text-px-muted">
          <span className="uppercase tracking-wider text-px-faint">
            {t("agentRole")}
          </span>{" "}
          <span className="text-px-text">
            {data.agent.id} · {data.agent.role}
          </span>
          {data.agent.description ? ` — ${data.agent.description}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="border border-px-line px-1 py-0.5 text-px-muted">
      <span className="text-px-faint">{label}</span> {value}
    </span>
  );
}

function PromptBlock({
  prompt,
}: {
  prompt: StageDetailData["prompt"];
}) {
  const t = useTranslations("stageDetail");
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 border-b border-px-line pb-1 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-px-muted" />
        ) : (
          <ChevronRight className="size-3.5 text-px-muted" />
        )}
        <Wrench className="size-3.5 text-px-accent" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-px-text">
          {t("prompt")}
        </span>
        {prompt?.truncated ? (
          <span className="ml-auto border border-amber-500/40 px-1 font-mono text-[9px] uppercase text-amber-300">
            {t("promptTruncated")}
          </span>
        ) : null}
      </button>
      {open ? (
        prompt?.available ? (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-px-line bg-px-ink p-2 font-mono text-[10px] leading-relaxed text-px-text">
            {prompt.text}
          </pre>
        ) : (
          <p className="mt-2 text-[11px] text-px-muted">{t("promptEmpty")}</p>
        )
      ) : null}
    </section>
  );
}

function ResultBlock({
  data,
  locale,
}: {
  data: StageDetailData;
  locale: string;
}) {
  const t = useTranslations("stageDetail");
  const transcript = data.transcript;
  if (!transcript?.available) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-px-muted">{t("noTranscript")}</p>
        {data.stageStatus === "running" ? (
          <p className="text-[10px] text-px-faint">{t("runningHint")}</p>
        ) : null}
      </div>
    );
  }

  const toolCalls = transcript.turns.flatMap((turn) => turn.toolCalls);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1.5">
        <Metric
          label={t("duration")}
          value={formatMillis(transcript.durationMs, locale)}
        />
        <Metric
          label={t("toolCalls")}
          value={formatNumber(transcript.toolCallCount)}
        />
        <Metric
          label={t("gateScore")}
          value={
            transcript.gateScore !== null ? String(transcript.gateScore) : "—"
          }
        />
      </div>

      {transcript.finalResponse ? (
        <div>
          <p className="font-mono text-[9px] uppercase tracking-wider text-px-faint">
            {t("finalResponse")}
          </p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words border border-px-line bg-px-ink p-2 text-[10px] leading-relaxed text-px-text">
            {transcript.finalResponse}
          </pre>
        </div>
      ) : null}

      {toolCalls.length > 0 ? (
        <ol className="space-y-1">
          {toolCalls.map((call) => (
            <li
              key={`${call.index}:${call.tool}`}
              className={cn(
                "border px-2 py-1 font-mono text-[10px]",
                call.isError
                  ? "border-red-500/40 bg-red-500/5 text-red-200"
                  : "border-px-line text-px-muted",
              )}
            >
              <span className="text-px-faint">{call.index}</span>{" "}
              <span className="text-px-text">{call.tool}</span>
              {call.argsSummary ? (
                <span className="ml-1 truncate text-px-muted">
                  {call.argsSummary}
                </span>
              ) : null}
              {call.resultSummary ? (
                <span className="mt-0.5 block truncate text-px-faint">
                  {call.resultSummary}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {transcript.inputs.length > 0 || transcript.outputArtifactId ? (
        <div className="space-y-1 font-mono text-[10px] text-px-muted">
          {transcript.inputs.length > 0 ? (
            <p>
              <span className="uppercase tracking-wider text-px-faint">
                {t("inputs")}
              </span>{" "}
              {transcript.inputs
                .map((input) => `${input.artifactId} v${input.version}`)
                .join(" · ")}
            </p>
          ) : null}
          {transcript.outputArtifactId ? (
            <p>
              <span className="uppercase tracking-wider text-px-faint">
                {t("output")}
              </span>{" "}
              {transcript.outputArtifactId}
            </p>
          ) : null}
        </div>
      ) : null}

      {transcript.truncated ? (
        <p className="text-[10px] text-amber-300">{t("transcriptTruncated")}</p>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-px-line bg-px-ink px-1.5 py-1">
      <p className="font-mono text-[9px] uppercase tracking-wider text-px-faint">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-px-text">
        {value}
      </p>
    </div>
  );
}

function formatMillis(ms: number | null, locale: string): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return locale === "zh" ? `${seconds} 秒` : `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return locale === "zh" ? `${minutes} 分 ${rest} 秒` : `${minutes}m ${rest}s`;
}

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 border-b border-px-line pb-1">
        <span className="text-px-accent">{icon}</span>
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest text-px-text">
          {title}
        </h3>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="border border-dashed border-px-line2 px-4 py-8 text-center">
      <FileText className="mx-auto mb-2 size-5 text-px-faint" />
      <p className="text-xs text-px-text">{title}</p>
      <p className="mt-1 text-[11px] text-px-muted">{hint}</p>
    </div>
  );
}

function statusVariant(status: string) {
  if (status === "succeeded" || status === "passed") {
    return "success" as const;
  }
  if (status === "failed" || status === "blocked") {
    return "danger" as const;
  }
  if (status === "running" || status === "applying") {
    return "info" as const;
  }
  if (status === "paused" || status === "stalled") {
    return "warning" as const;
  }
  return "outline" as const;
}
