"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

interface BootstrapFormProps {
  initial: {
    configured: boolean;
    baseUrl: string;
    flash: string;
    pro: string;
  };
}

interface ProbeError {
  kind: "auth" | "quota" | "bad_request" | "network" | "unknown";
  message: string;
}

interface SavedState {
  baseUrl: string;
  flash: string;
  pro: string;
  backend: string;
  latencyMs: number;
  models?: string[];
}

export function BootstrapForm({ initial }: BootstrapFormProps) {
  const t = useTranslations("welcome");
  const router = useRouter();
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [flash, setFlash] = useState(initial.flash);
  const [pro, setPro] = useState(initial.pro);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ProbeError | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, baseUrl, flash, pro }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        keyBackend?: string;
        probe?: { latencyMs: number; models?: string[]; error?: ProbeError };
      };
      if (!response.ok || !payload.ok) {
        const probeError = payload.probe?.error;
        setError(
          probeError ?? {
            kind: "unknown",
            message: payload.error ?? t("probeFailed"),
          },
        );
        return;
      }
      setApiKey("");
      setSaved({
        baseUrl,
        flash,
        pro,
        backend: payload.keyBackend ?? "file",
        latencyMs: payload.probe?.latencyMs ?? 0,
        ...(payload.probe?.models ? { models: payload.probe.models } : {}),
      });
      router.refresh();
    } catch (problem) {
      setError({
        kind: "network",
        message: problem instanceof Error ? problem.message : String(problem),
      });
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="space-y-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-5">
        <div className="flex items-center gap-2 text-emerald-300">
          <CheckCircle2 className="size-5" />
          <h2 className="text-sm font-medium">{t("savedTitle")}</h2>
        </div>
        <p className="text-[12px] leading-relaxed text-zinc-400">
          {t("savedBody", {
            backend: saved.backend,
            flash: saved.flash,
            pro: saved.pro,
            ms: saved.latencyMs,
          })}
        </p>
        {saved.models && saved.models.length > 0 ? (
          <p className="font-mono text-[11px] text-zinc-500">
            {saved.models.slice(0, 8).join(" · ")}
          </p>
        ) : null}
        <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px] text-zinc-400">
          <p className="font-mono text-zinc-300">{t("nextSteps")}</p>
          <p className="mt-1">1. kit up</p>
          <p>2. kit init --list</p>
        </div>
        <Button size="sm" asChild>
          <Link href="/">{t("goConsole")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border bg-card p-5 shadow-[4px_4px_0_#000]"
    >
      {initial.configured ? (
        <div className="rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-200/80">
          {t("alreadyBody")}
        </div>
      ) : null}

      <label htmlFor={`${id}-key`} className="block space-y-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300">
          <KeyRound className="size-3.5 text-amber-300" />
          {t("keyLabel")}
        </span>
        <Input
          id={`${id}-key`}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={t("keyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          required
        />
        <span className="block text-[10px] text-zinc-600">{t("keyHint")}</span>
      </label>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-zinc-400">
          {t("advanced")}
        </summary>
        <div className="mt-3 space-y-3">
          <label htmlFor={`${id}-base-url`} className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("baseUrlLabel")}
            </span>
            <Input
              id={`${id}-base-url`}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="font-mono text-xs"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label htmlFor={`${id}-flash`} className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("flashLabel")}
              </span>
              <Input
                id={`${id}-flash`}
                value={flash}
                onChange={(event) => setFlash(event.target.value)}
                className="font-mono text-xs"
              />
            </label>
            <label htmlFor={`${id}-pro`} className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("proLabel")}
              </span>
              <Input
                id={`${id}-pro`}
                value={pro}
                onChange={(event) => setPro(event.target.value)}
                className="font-mono text-xs"
              />
            </label>
          </div>
        </div>
      </details>

      {error ? (
        <div
          className={cn(
            "space-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2",
          )}
        >
          <p className="flex items-center gap-1.5 text-[11px] text-red-300">
            <XCircle className="size-3.5" />
            {t("probeFailed")} · {t(`error_${error.kind}`)}
          </p>
          <p className="break-all font-mono text-[10px] text-zinc-500">
            {error.message}
          </p>
        </div>
      ) : null}

      <Button
        type="submit"
        disabled={busy || !apiKey.trim()}
        className="w-full"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {busy ? t("connecting") : t("connect")}
      </Button>
    </form>
  );
}
