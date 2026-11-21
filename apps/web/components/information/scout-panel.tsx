"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Radar, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface ScoutItem {
  sourceId: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string;
}

interface ScoutToolCall {
  tool: string;
  risk: string;
  ok: boolean;
  durationMs: number;
  injectionSuspected: boolean;
  error?: string;
}

interface ScoutResponse {
  ok?: boolean;
  allowNetwork?: boolean;
  queries?: string[];
  warnings?: string[];
  ingested?: {
    items: number;
    eventsCreated: number;
    scored: number;
    duplicates: number;
  };
  toolCalls?: ScoutToolCall[];
  items?: ScoutItem[];
  error?: string;
}

/**
 * Active research entry (98 §3.1 / I-4, D-64 shape).
 *
 * One sentence → audited read-only tool loop → information events. The panel
 * only triggers research and shows provenance; it never edits the interest
 * profile, rules or budgets.
 */
export function ScoutPanel({ networkEnabled }: { networkEnabled: boolean }) {
  const t = useTranslations("information");
  const router = useRouter();
  const [intent, setIntent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScoutResponse | null>(null);

  async function run() {
    setError(null);
    if (!intent.trim()) {
      setError(t("scoutIntentRequired"));
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/information/scout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: intent.trim() }),
      });
      const payload = (await response.json()) as ScoutResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? t("scoutFailed"));
      }
      setResult(payload);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("scoutFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="violet">
          <Radar className="mr-1 size-3" />
          {t("scoutTitle")}
        </Badge>
        <Badge variant={networkEnabled ? "success" : "outline"}>
          {networkEnabled ? t("scoutNetworkOn") : t("scoutNetworkOff")}
        </Badge>
      </div>
      <p className="text-[10px] text-zinc-500">{t("scoutHint")}</p>

      <label
        htmlFor="scout-intent"
        className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
      >
        {t("scoutIntentLabel")}
        <Textarea
          id="scout-intent"
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder={t("scoutIntentPlaceholder")}
          className="min-h-16 text-sm"
        />
      </label>

      <Button size="sm" onClick={() => void run()} disabled={pending}>
        <Radar className="size-3.5" />
        {pending ? t("scoutRunning") : t("scoutButton")}
      </Button>

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      ) : null}

      {result?.ingested ? (
        <div className="space-y-2 rounded-md border border-border bg-zinc-950/60 p-2.5">
          <p className="font-mono text-[10px] text-zinc-400">
            {t("scoutResult", {
              events: result.ingested.eventsCreated,
              duplicates: result.ingested.duplicates,
              calls: result.toolCalls?.length ?? 0,
            })}
          </p>
          {result.queries && result.queries.length > 0 ? (
            <p className="text-[10px] text-zinc-500">
              {t("scoutQueries")}: {result.queries.join(" · ")}
            </p>
          ) : null}
          {result.items && result.items.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("scoutItems")}
              </p>
              <ul className="space-y-1">
                {result.items.map((item) => (
                  <li
                    key={`${item.sourceId}-${item.url}`}
                    className="text-[10px]"
                  >
                    {item.url.startsWith("http") ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-300 hover:underline"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <span className="text-zinc-300">{item.title}</span>
                    )}
                    <span className="ml-1 font-mono text-[9px] text-zinc-600">
                      {item.sourceId}
                    </span>
                    {item.summary ? (
                      <p className="text-zinc-500">{item.summary}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[10px] text-zinc-500">{t("scoutNoItems")}</p>
          )}
          {result.warnings && result.warnings.length > 0 ? (
            <div className="space-y-0.5">
              <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
                <ShieldAlert className="size-3" />
                {t("scoutWarnings")}
              </p>
              <ul className="space-y-0.5 text-[9px] text-zinc-500">
                {result.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.toolCalls && result.toolCalls.length > 0 ? (
            <div className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("scoutToolCalls")}
              </p>
              <ul className="space-y-0.5 font-mono text-[9px] text-zinc-500">
                {result.toolCalls.map((call, index) => (
                  <li key={`${call.tool}-${index}`}>
                    {call.ok ? "ok" : "denied"} · {call.tool} · {call.risk} ·{" "}
                    {call.durationMs}ms
                    {call.injectionSuspected ? " · injection-suspected" : ""}
                    {call.error ? ` · ${call.error}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
