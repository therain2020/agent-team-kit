"use client";

import type { KillSwitch, KillSwitchScope } from "@kit/core";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface KillSwitchState {
  active: KillSwitch[];
  recent: KillSwitch[];
}

const SCOPES: KillSwitchScope[] = [
  "global",
  "workspace",
  "agent-source",
  "stage",
];

export function KillSwitchConsole({
  initial,
}: {
  initial: KillSwitchState;
}) {
  const t = useTranslations("killSwitch");
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [scope, setScope] = useState<KillSwitchScope>("workspace");
  const [target, setTarget] = useState("");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [reason, setReason] = useState("");
  const [releaseReason, setReleaseReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsTarget = scope === "agent-source" || scope === "stage";
  const needsWorkspace = scope === "workspace" || needsTarget;
  const scopeLabels: Record<KillSwitchScope, string> = {
    global: t("scopeGlobal"),
    workspace: t("scopeWorkspace"),
    "agent-source": t("scopeAgentSource"),
    stage: t("scopeStage"),
  };

  async function refresh() {
    const response = await fetch("/api/kill-switch", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    setState((await response.json()) as KillSwitchState);
    router.refresh();
  }

  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? t("failed"));
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError(t("failed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    const ok = await submit({
      action: "activate",
      scope,
      target: needsTarget ? target.trim() : undefined,
      workspaceId: needsWorkspace ? workspaceId.trim() : undefined,
      reason: reason.trim(),
      confirm: confirmed,
    });
    if (ok) {
      setReason("");
      setConfirmed(false);
    }
  }

  async function release(switchId: string) {
    const ok = await submit({
      action: "release",
      switchId,
      reason: releaseReason.trim(),
      confirm: true,
    });
    if (ok) {
      setReleaseReason("");
    }
  }

  const disabled =
    busy ||
    reason.trim().length === 0 ||
    !confirmed ||
    (needsTarget && target.trim().length === 0) ||
    (needsWorkspace && workspaceId.trim().length === 0);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-zinc-200">
          {t("activateTitle")}
        </h2>
        <p className="mt-1 text-xs text-zinc-500">{t("activateHint")}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="text-xs text-zinc-400">
            {t("scope")}
            <select
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as KillSwitchScope)
              }
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-zinc-200"
            >
              {SCOPES.map((item) => (
                <option key={item} value={item}>
                  {scopeLabels[item]}
                </option>
              ))}
            </select>
          </label>
          {needsTarget ? (
            <label className="text-xs text-zinc-400">
              {t("target")}
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={t("targetPlaceholder")}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-zinc-200"
              />
            </label>
          ) : null}
          {needsWorkspace ? (
            <label className="text-xs text-zinc-400">
              {t("workspace")}
              <input
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                placeholder="default"
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-zinc-200"
              />
            </label>
          ) : null}
          <label className="text-xs text-zinc-400 md:col-span-2">
            {t("reason")}
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("reasonPlaceholder")}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-zinc-200"
            />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {t("confirm")}
        </label>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void activate()}
            disabled={disabled}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {t("activate")}
          </button>
          {error ? <span className="text-xs text-red-400">{error}</span> : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-zinc-200">
            {t("activeTitle")}
          </h2>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            {t("releaseReason")}
            <input
              value={releaseReason}
              onChange={(event) => setReleaseReason(event.target.value)}
              placeholder={t("reasonPlaceholder")}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-zinc-200"
            />
          </label>
        </div>
        {state.active.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">{t("emptyActive")}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {state.active.map((item) => (
              <li
                key={item.switchId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-900/40 bg-red-950/20 px-3 py-2"
              >
                <div className="text-xs text-red-100">
                  <span className="font-mono">
                    {item.scope}/{item.target || "*"}
                  </span>
                  <span className="mx-2 text-red-300/70">{item.reason}</span>
                  <span className="text-red-400/60">
                    {t("activatedBy", {
                      actor: item.activatedBy,
                      version: item.version,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void release(item.switchId)}
                  disabled={busy || releaseReason.trim().length === 0}
                  className="rounded-md border border-red-700/60 px-2.5 py-1 text-xs text-red-100 disabled:opacity-40"
                >
                  {t("release")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-medium text-zinc-200">
          {t("recentTitle")}
        </h2>
        {state.recent.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">{t("emptyRecent")}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {state.recent.map((item) => (
              <li
                key={item.switchId}
                className="rounded-md border border-border/70 px-3 py-2 text-xs text-zinc-400"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-zinc-300">
                    {item.scope}/{item.target || "*"}
                  </span>
                  <span
                    className={
                      item.state === "active" ? "text-red-300" : "text-zinc-500"
                    }
                  >
                    {item.state}
                  </span>
                  <span>{item.reason}</span>
                  {item.releaseReason ? (
                    <span className="text-zinc-600">
                      → {item.releaseReason}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-[10px] text-zinc-600">
                  {item.activatedAt}
                  {item.releasedAt ? ` → ${item.releasedAt}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
