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
import { cn } from "@/lib/utils";
import {
  type WorkshopAssetKind,
  installDestination,
  manifestAssetKind,
  matchesAssetKind,
} from "@/lib/workshop-library";
import type {
  WorkshopCandidate,
  WorkshopManifest,
  WorkshopPreview,
  WorkshopTrust,
} from "@kit/workshop";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

function riskLevel(manifest: WorkshopManifest): "low" | "medium" | "high" {
  if (manifest.permissions.code) {
    return "high";
  }
  if (
    manifest.permissions.network ||
    manifest.permissions.filesystem !== "none"
  ) {
    return "medium";
  }
  return "low";
}

const TRUST_VARIANT: Record<
  WorkshopTrust["level"],
  "success" | "info" | "warning"
> = {
  builtin: "success",
  verified: "info",
  community: "warning",
};

const PERMISSION_RISK_VARIANT = {
  low: "outline",
  medium: "warning",
  high: "danger",
} as const;

/**
 * Shared search-and-preview surface for one asset partition (88 §3.4 M2).
 * Search, preview, trust grading, secret scan and the consent flow are the
 * same for teams, pipelines, components and templates; only the result filter
 * and the install destination differ.
 */
export function WorkshopMarket({
  kind,
  kindLabel,
  installedRepos,
  query,
  onQueryChange,
}: {
  kind: WorkshopAssetKind;
  kindLabel: string;
  installedRepos: string[];
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const t = useTranslations("workshop");
  const router = useRouter();
  const [results, setResults] = useState<WorkshopCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkshopCandidate | null>(null);
  const [preview, setPreview] = useState<WorkshopPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [allowCode, setAllowCode] = useState(false);
  const [acceptUnsigned, setAcceptUnsigned] = useState(false);
  const [acceptHighRisk, setAcceptHighRisk] = useState(false);
  const [hostPack, setHostPack] = useState("");
  const [installing, setInstalling] = useState(false);

  const trustLabels: Record<WorkshopTrust["level"], string> = {
    builtin: t("trustBuiltin"),
    verified: t("trustVerified"),
    community: t("trustCommunity"),
  };
  const signatureLabels: Record<WorkshopTrust["signature"], string> = {
    valid: t("signatureValid"),
    invalid: t("signatureInvalid"),
    "unknown-key": t("signatureUnknownKey"),
    missing: t("signatureMissing"),
  };
  const permissionLabels: Record<string, string> = {
    network: t("permNetwork"),
    "filesystem:readonly": t("permFilesystemReadonly"),
    "filesystem:workspace": t("permFilesystemWorkspace"),
    code: t("permCode"),
  };

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workshop?query=${encodeURIComponent(query)}`,
      );
      const payload = (await response.json()) as {
        candidates?: WorkshopCandidate[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("searchFailed"));
      }
      const candidates = (payload.candidates ?? []).filter(
        (candidate) =>
          candidate.manifest !== undefined &&
          matchesAssetKind(candidate.manifest.kind, kind),
      );
      setResults(candidates);
      if (candidates.length === 0) {
        toast.message(t("noResultsKind", { kind: kindLabel }));
      }
    } catch (problem) {
      const text =
        problem instanceof Error ? problem.message : t("searchError");
      setError(text);
      toast.error(text);
    } finally {
      setSearching(false);
    }
  }

  async function openPreview(candidate: WorkshopCandidate) {
    setSelected(candidate);
    setPreview(null);
    setPreviewError(null);
    setConfirmed(false);
    setAllowCode(false);
    setAcceptUnsigned(false);
    setAcceptHighRisk(false);
    setPreviewing(true);
    try {
      const response = await fetch(
        `/api/workshop/preview?repo=${encodeURIComponent(candidate.repo)}`,
      );
      const payload = (await response.json()) as WorkshopPreview & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("previewFailed"));
      }
      setPreview(payload);
    } catch (problem) {
      setPreviewError(
        problem instanceof Error ? problem.message : t("previewFailed"),
      );
    } finally {
      setPreviewing(false);
    }
  }

  function closeDialog() {
    setSelected(null);
    setPreview(null);
    setPreviewError(null);
    setConfirmed(false);
    setAllowCode(false);
    setAcceptUnsigned(false);
    setAcceptHighRisk(false);
  }

  async function install() {
    if (!preview || !confirmed) {
      return;
    }
    if (preview.secretFindings.length > 0) {
      return;
    }
    if (preview.manifest.permissions.code && !allowCode) {
      return;
    }
    if (preview.trust.level === "community" && !acceptUnsigned) {
      return;
    }
    if (preview.permissions.highRisk.length > 0 && !acceptHighRisk) {
      return;
    }
    if (preview.manifest.kind === "pipeline" && !hostPack.trim()) {
      return;
    }
    setInstalling(true);
    try {
      const response = await fetch("/api/workshop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: preview.repo,
          ref: preview.commit,
          confirm: true,
          allowCode,
          acceptUnsigned,
          acceptHighRisk,
          ...(hostPack.trim() ? { hostPack: hostPack.trim() } : {}),
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        name?: string;
        id?: string;
        kind?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("installFailed"));
      }
      const name = payload.name ?? preview.manifest.name;
      if (payload.kind === "pack" && payload.id) {
        toast.success(t("installedPack", { name }));
        closeDialog();
        // Packs live in the pack library: hard-navigate so the console
        // re-renders with the installed pack selected.
        window.location.assign(`/packs?pack=${encodeURIComponent(payload.id)}`);
      } else {
        toast.success(
          t("installedStaged", {
            name,
            dir: payload.id ?? preview.manifest.id,
          }),
        );
        closeDialog();
        router.refresh();
      }
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("installFailed"),
      );
    } finally {
      setInstalling(false);
    }
  }

  const risk = preview ? riskLevel(preview.manifest) : "low";
  const riskLabel =
    risk === "high"
      ? t("riskHigh")
      : risk === "medium"
        ? t("riskMedium")
        : t("riskLow");
  const riskReason =
    risk === "high"
      ? t("riskHighReason")
      : risk === "medium"
        ? t("riskMediumReason")
        : t("riskLowReason");
  const codeBlocked = Boolean(preview?.manifest.permissions.code && !allowCode);
  const secretBlocked = Boolean(preview && preview.secretFindings.length > 0);
  const unsignedBlocked = Boolean(
    preview && preview.trust.level === "community" && !acceptUnsigned,
  );
  const highRiskBlocked = Boolean(
    preview && preview.permissions.highRisk.length > 0 && !acceptHighRisk,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[11px] text-amber-200/90">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <p>{t("securityNotice")}</p>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Search className="size-4 text-sky-400" />
            {t("marketTitle")}
          </h2>
          <span className="font-mono text-[10px] text-zinc-600">
            {t("topicLabel")}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void search();
              }
            }}
            placeholder={t("searchPlaceholder")}
            className="h-8 text-[11px]"
          />
          <Button size="sm" onClick={search} disabled={searching}>
            <RefreshCw
              className={cn("size-3.5", searching && "animate-spin")}
            />
            {t("search")}
          </Button>
        </div>
        {error ? (
          <p className="mt-2 whitespace-pre-wrap text-[10px] text-red-300">
            {error}
          </p>
        ) : null}

        <ul className="mt-3 space-y-2">
          {results.map((candidate) => {
            const installedRepo = installedRepos.includes(candidate.repo);
            return (
              <li
                key={candidate.repo}
                className="rounded-lg border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-zinc-200">
                    {candidate.repo}
                  </span>
                  <span className="text-[10px] text-amber-300/80">
                    ★ {candidate.stars}
                  </span>
                  {candidate.manifest ? (
                    <Badge variant="success">
                      {candidate.manifest.name}@{candidate.manifest.version}
                    </Badge>
                  ) : (
                    <Badge variant="danger">{t("invalidManifest")}</Badge>
                  )}
                  {candidate.trust ? (
                    <Badge variant={TRUST_VARIANT[candidate.trust.level]}>
                      {trustLabels[candidate.trust.level]}
                    </Badge>
                  ) : null}
                  {installedRepo ? (
                    <Badge variant="info">{t("installedLabel")}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  {candidate.description || "—"}
                </p>
                {candidate.manifestError ? (
                  <p className="mt-1 text-[10px] text-red-300/80">
                    {candidate.manifestError}
                  </p>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <a
                    href={`${candidate.htmlUrl}/blob/HEAD/workshop.yaml`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200"
                  >
                    <ExternalLink className="size-3" />
                    workshop.yaml
                  </a>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={!candidate.manifest}
                    onClick={() => void openPreview(candidate)}
                  >
                    <Download className="size-3.5" />
                    {t("preview")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {results.length === 0 && !searching ? (
          <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
            {t("searchHint")}
          </p>
        ) : null}
      </section>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("previewTitle", {
                name: selected?.manifest?.name ?? selected?.repo ?? "",
              })}
            </DialogTitle>
            <DialogDescription>{t("confirmDescription")}</DialogDescription>
          </DialogHeader>

          {previewing ? (
            <p className="flex items-center gap-2 text-[11px] text-zinc-400">
              <RefreshCw className="size-3.5 animate-spin" />
              {t("previewing")}
            </p>
          ) : null}
          {previewError ? (
            <p className="whitespace-pre-wrap text-[11px] text-red-300">
              {previewError}
            </p>
          ) : null}

          {preview ? (
            <div className="space-y-3 text-[11px] text-zinc-400">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-zinc-200">
                  {preview.repo}@{preview.commit.slice(0, 8)}
                </span>
                <Badge variant="outline">{preview.manifest.kind}</Badge>
                <Badge variant="outline">v{preview.manifest.version}</Badge>
                <Badge variant={TRUST_VARIANT[preview.trust.level]}>
                  {trustLabels[preview.trust.level]}
                </Badge>
                <Badge variant="outline">
                  {signatureLabels[preview.trust.signature]}
                </Badge>
                {preview.manifest.license ? (
                  <Badge variant="outline">{preview.manifest.license}</Badge>
                ) : null}
              </div>
              <p>{preview.manifest.description || "—"}</p>
              <p className="text-[10px] text-zinc-500">
                {t("destinationLibrary", {
                  path: installDestination(
                    manifestAssetKind(preview.manifest.kind) ?? kind,
                    preview.manifest.id,
                    preview.manifest.kind,
                    hostPack.trim(),
                  ),
                })}
              </p>

              {preview.manifest.kind === "pipeline" ? (
                <label className="block space-y-1 text-[10px] text-zinc-500">
                  <span>{t("hostPackLabel")}</span>
                  <Input
                    value={hostPack}
                    onChange={(event) => setHostPack(event.target.value)}
                    placeholder={t("hostPackPlaceholder")}
                    className="h-7 font-mono text-[11px]"
                  />
                  <span>{t("hostPackHint")}</span>
                </label>
              ) : null}

              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
                <span className="text-zinc-500">{t("entry")}</span>
                <span className="font-mono">{preview.manifest.entry}</span>
                <span className="text-zinc-500">{t("compatibility")}</span>
                <span>{preview.manifest.compatibility?.kit ?? "—"}</span>
                <span className="text-zinc-500">{t("topics")}</span>
                <span>
                  {preview.manifest.topics.length
                    ? preview.manifest.topics.join(", ")
                    : "—"}
                </span>
              </div>

              <div>
                <p className="text-zinc-500">{t("permissionsTitle")}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {preview.permissions.entries.length === 0 ? (
                    <span className="text-[10px] text-zinc-500">
                      {t("noPermissions")}
                    </span>
                  ) : (
                    preview.permissions.entries.map((entry) => (
                      <Badge
                        key={entry.id}
                        variant={PERMISSION_RISK_VARIANT[entry.risk]}
                      >
                        {permissionLabels[entry.id] ?? entry.label}
                      </Badge>
                    ))
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-zinc-500">{t("risk")}:</span>
                <Badge
                  variant={
                    risk === "high"
                      ? "danger"
                      : risk === "medium"
                        ? "warning"
                        : "success"
                  }
                >
                  {riskLabel}
                </Badge>
                <span className="text-[10px] text-zinc-500">{riskReason}</span>
              </div>

              <div>
                <p className="text-zinc-500">{t("secretTitle")}</p>
                {preview.secretFindings.length === 0 ? (
                  <p className="mt-1 text-[10px] text-emerald-300/90">
                    {t("secretClean")}
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1 text-[10px] text-red-300">
                    {preview.secretFindings.map((finding) => (
                      <li
                        key={`${finding.file}:${finding.line}:${finding.label}`}
                      >
                        {t("secretBlocked", {
                          file: finding.file,
                          line: finding.line,
                          label: finding.label,
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <details>
                <summary className="cursor-pointer text-zinc-500">
                  {t("filesTitle")} ({preview.manifest.files.length})
                </summary>
                <ul className="mt-1 max-h-28 overflow-auto font-mono text-[10px] text-zinc-500">
                  {preview.manifest.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>

              <div>
                <p className="text-zinc-500">
                  {t("entry")} · {t("previewNote")}
                </p>
                <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-black/30 p-2 font-mono text-[10px] text-zinc-400">
                  {preview.entryPreview}
                </pre>
              </div>

              <label className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-200/90">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-amber-500"
                />
                <span>{t("confirmCheckbox")}</span>
              </label>

              {preview.trust.level === "community" ? (
                <label className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-200/90">
                  <input
                    type="checkbox"
                    checked={acceptUnsigned}
                    onChange={(event) =>
                      setAcceptUnsigned(event.target.checked)
                    }
                    className="mt-0.5 size-3.5 accent-amber-500"
                  />
                  <span>{t("confirmUnsigned")}</span>
                </label>
              ) : null}

              {preview.permissions.highRisk.length > 0 ? (
                <label className="flex items-start gap-2 rounded border border-red-500/25 bg-red-500/5 p-2 text-[10px] text-red-200/90">
                  <input
                    type="checkbox"
                    checked={acceptHighRisk}
                    onChange={(event) =>
                      setAcceptHighRisk(event.target.checked)
                    }
                    className="mt-0.5 size-3.5 accent-red-500"
                  />
                  <span>{t("confirmHighRisk")}</span>
                </label>
              ) : null}

              {preview.manifest.permissions.code ? (
                <label className="flex items-start gap-2 rounded border border-red-500/25 bg-red-500/5 p-2 text-[10px] text-red-200/90">
                  <input
                    type="checkbox"
                    checked={allowCode}
                    onChange={(event) => setAllowCode(event.target.checked)}
                    className="mt-0.5 size-3.5 accent-red-500"
                  />
                  <span className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>
                      {t("codeWarning")} {t("allowCode")}
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("cancel")}
            </Button>
            <Button
              onClick={install}
              disabled={
                !preview ||
                !confirmed ||
                installing ||
                codeBlocked ||
                secretBlocked ||
                unsignedBlocked ||
                highRiskBlocked ||
                (preview?.manifest.kind === "pipeline" && !hostPack.trim())
              }
            >
              {installing ? t("installing") : t("installButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
