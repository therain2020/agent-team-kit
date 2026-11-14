"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ShieldAlert, ShieldOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export interface DegradationModeView {
  modeId: string;
  scope: "workspace" | "global";
  workspaceId: string;
  kind: "degraded" | "read_only";
  behavior: string;
  enteredAt: string;
  enteredBy: string;
}

export interface DependencyView {
  id: string;
  kind: string;
  criticality: string;
  failureMode: "fail_open" | "fail_closed";
  description: string;
}

export function DegradationControls({
  modes,
  dependencies,
}: {
  modes: DegradationModeView[];
  dependencies: DependencyView[];
}) {
  const t = useTranslations("degradation");
  const router = useRouter();

  const [scope, setScope] = useState<"workspace" | "global">("workspace");
  const [kind, setKind] = useState<"degraded" | "read_only">("degraded");
  const [dependencyId, setDependencyId] = useState(dependencies[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState("default");
  const [reason, setReason] = useState("");
  const [minChars, setMinChars] = useState(20);
  const [minStableMinutes, setMinStableMinutes] = useState(0);
  const [securityEvent, setSecurityEvent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [exitModeId, setExitModeId] = useState(modes[0]?.modeId ?? "");
  const [exitReason, setExitReason] = useState("");
  const [recheck, setRecheck] = useState(false);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  const selectedMode =
    modes.find((mode) => mode.modeId === exitModeId) ?? modes[0];

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      error?: string;
      reasons?: string[];
    };
    if (!response.ok) {
      const reasons = Array.isArray(payload.reasons)
        ? payload.reasons.join("; ")
        : "";
      throw new Error(
        [payload.error ?? `request failed (${response.status})`, reasons]
          .filter(Boolean)
          .join(": "),
      );
    }
    return payload;
  }

  async function enter() {
    setPending(true);
    setError(null);
    try {
      await post("/api/degradation/enter", {
        scope,
        ...(scope === "workspace" ? { workspaceId } : {}),
        kind,
        dependencyId,
        reason,
        minChars,
        minStableMinutes,
        securityEvent,
      });
      setReason("");
      toast.success(t("entered"));
      router.refresh();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : t("actionFailed"),
      );
    } finally {
      setPending(false);
    }
  }

  async function exit() {
    if (!selectedMode) {
      return;
    }
    setExitPending(true);
    setExitError(null);
    try {
      await post("/api/degradation/exit", {
        scope: selectedMode.scope,
        workspaceId: selectedMode.workspaceId,
        reason: exitReason,
        qualityRecheck: recheck,
      });
      setExitReason("");
      setRecheck(false);
      toast.success(t("exited"));
      router.refresh();
    } catch (actionError) {
      setExitError(
        actionError instanceof Error ? actionError.message : t("actionFailed"),
      );
    } finally {
      setExitPending(false);
    }
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-red-400" />
            {t("enterTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label={t("scope")}>
            <Select
              value={scope}
              onChange={(value) =>
                setScope(value === "global" ? "global" : "workspace")
              }
              options={[
                { value: "workspace", label: t("scopeWorkspace") },
                { value: "global", label: t("scopeGlobal") },
              ]}
            />
          </Field>
          {scope === "workspace" ? (
            <Field label={t("workspaceLabel")}>
              <Input
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                placeholder="default"
              />
            </Field>
          ) : (
            <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={securityEvent}
                onChange={(event) => setSecurityEvent(event.target.checked)}
                className="mt-0.5 size-3.5 accent-red-500"
              />
              {t("securityEvent")}
            </label>
          )}
          <Field label={t("kind")}>
            <Select
              value={kind}
              onChange={(value) =>
                setKind(value === "read_only" ? "read_only" : "degraded")
              }
              options={[
                { value: "degraded", label: t("kindDegraded") },
                { value: "read_only", label: t("kindReadOnly") },
              ]}
            />
          </Field>
          <Field label={t("dependency")}>
            <Select
              value={dependencyId}
              onChange={setDependencyId}
              options={dependencies.map((dependency) => ({
                value: dependency.id,
                label: `${dependency.id} · ${dependency.failureMode === "fail_open" ? t("failOpen") : t("failClosed")}`,
              }))}
            />
          </Field>
          <Field label={t("reason")}>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("reasonPlaceholder")}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("minChars")}>
              <Input
                type="number"
                min={0}
                value={minChars}
                onChange={(event) => setMinChars(Number(event.target.value))}
              />
            </Field>
            <Field label={t("minStableMinutes")}>
              <Input
                type="number"
                min={0}
                value={minStableMinutes}
                onChange={(event) =>
                  setMinStableMinutes(Number(event.target.value))
                }
              />
            </Field>
          </div>
          {error ? <ErrorLine text={error} /> : null}
          <Button
            onClick={enter}
            disabled={
              pending ||
              reason.trim().length === 0 ||
              (scope === "global" && !securityEvent)
            }
          >
            {pending ? t("entering") : t("enter")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="size-4 text-amber-400" />
            {t("exitTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {modes.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("empty")}</p>
          ) : (
            <>
              <Field label={t("mode")}>
                <Select
                  value={exitModeId}
                  onChange={setExitModeId}
                  options={modes.map((mode) => ({
                    value: mode.modeId,
                    label: `${mode.kind === "read_only" ? t("kindReadOnly") : t("kindDegraded")} · ${mode.scope === "global" ? t("globalLabel") : mode.workspaceId}`,
                  }))}
                />
              </Field>
              <Field label={t("exitReason")}>
                <Input
                  value={exitReason}
                  onChange={(event) => setExitReason(event.target.value)}
                  placeholder={t("reasonPlaceholder")}
                />
              </Field>
              <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={recheck}
                  onChange={(event) => setRecheck(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-emerald-500"
                />
                {t("qualityRecheck")}
              </label>
              {exitError ? <ErrorLine text={exitError} /> : null}
              <Button
                variant="outline"
                onClick={exit}
                disabled={
                  exitPending || !selectedMode || exitReason.trim().length === 0
                }
              >
                {exitPending ? t("exiting") : t("exit")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-zinc-300">{label}</p>
      {children}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
      {text}
    </p>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-sm text-zinc-200 outline-none focus:border-ring"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
