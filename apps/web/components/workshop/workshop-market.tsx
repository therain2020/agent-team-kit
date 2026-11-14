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
import type {
  WorkshopCandidate,
  WorkshopInstallRecord,
  WorkshopManifest,
  WorkshopPreview,
} from "@kit/workshop";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
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

export function WorkshopMarket({
  installed,
}: {
  installed: WorkshopInstallRecord[];
}) {
  const t = useTranslations("workshop");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkshopCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkshopCandidate | null>(null);
  const [preview, setPreview] = useState<WorkshopPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [allowCode, setAllowCode] = useState(false);
  const [installing, setInstalling] = useState(false);

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
      setResults(payload.candidates ?? []);
      if ((payload.candidates ?? []).length === 0) {
        toast.message(t("noResults"));
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
  }

  async function install() {
    if (!preview || !confirmed) {
      return;
    }
    if (preview.manifest.permissions.code && !allowCode) {
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
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        name?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("installFailed"));
      }
      toast.success(
        t("installed", { name: payload.name ?? preview.manifest.name }),
      );
      closeDialog();
      router.refresh();
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

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[11px] text-amber-200/90">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <p>{t("securityNotice")}</p>
      </div>

      <details className="rounded-xl border border-border bg-card px-4 py-3 text-[11px] text-zinc-400">
        <summary className="cursor-pointer font-medium text-zinc-200">
          {t("publishTitle")}
        </summary>
        <p className="mt-2">{t("publishDescription")}</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-[10px] text-zinc-500">
          <li>{t("publishStepManifest")}</li>
          <li>{t("publishStepTopic")}</li>
          <li>{t("publishStepPush")}</li>
        </ol>
        <pre className="mt-2 overflow-auto rounded border border-border bg-black/30 p-2 font-mono text-[10px] text-zinc-400">
          kit workshop publish ./packs/my-team
        </pre>
      </details>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Store className="size-4 text-emerald-400" />
              {t("installedTitle")}
            </h2>
            <Badge variant="outline">{installed.length}</Badge>
          </div>
          {installed.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
              {t("noInstalled")}
            </p>
          ) : (
            <ul className="space-y-2">
              {installed.map((record) => (
                <li
                  key={record.dirName}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {record.name}
                    </span>
                    <Badge variant="outline">v{record.version}</Badge>
                    <Badge variant="outline">{record.kind}</Badge>
                    <Badge variant="warning">{t("thirdParty")}</Badge>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-zinc-500">
                    {record.repo}@{record.commit.slice(0, 8)}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-zinc-600">
                    {t("manifestHash")}: {record.manifestSha256.slice(0, 16)}
                    {record.manifestSha256.length > 16 ? "…" : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">
                      {t("network")}:{" "}
                      {record.permissions.network
                        ? t("enabled")
                        : t("disabled")}
                    </Badge>
                    <Badge variant="outline">
                      {t("filesystem")}:{" "}
                      {record.permissions.filesystem === "none"
                        ? t("fsNone")
                        : record.permissions.filesystem === "readonly"
                          ? t("fsReadonly")
                          : t("fsWorkspace")}
                    </Badge>
                    <Badge
                      variant={record.permissions.code ? "warning" : "outline"}
                    >
                      {t("code")}:{" "}
                      {record.permissions.code ? t("enabled") : t("disabled")}
                    </Badge>
                    <Badge variant="outline">
                      {t("files", { count: record.fileCount })}
                    </Badge>
                    {record.installedAt ? (
                      <span className="text-[10px] text-zinc-600">
                        {record.installedAt.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                  <a
                    href={`https://github.com/${record.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200"
                  >
                    <ExternalLink className="size-3" />
                    {t("viewRepo")}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

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
              onChange={(event) => setQuery(event.target.value)}
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
              const installedRepo = installed.find(
                (record) => record.repo === candidate.repo,
              );
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
      </div>

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
                {preview.manifest.license ? (
                  <Badge variant="outline">{preview.manifest.license}</Badge>
                ) : null}
              </div>
              <p>{preview.manifest.description || "—"}</p>

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
                  <Badge variant="outline">
                    {t("network")}:{" "}
                    {preview.manifest.permissions.network
                      ? t("enabled")
                      : t("disabled")}
                  </Badge>
                  <Badge variant="outline">
                    {t("filesystem")}:{" "}
                    {preview.manifest.permissions.filesystem === "none"
                      ? t("fsNone")
                      : preview.manifest.permissions.filesystem === "readonly"
                        ? t("fsReadonly")
                        : t("fsWorkspace")}
                  </Badge>
                  <Badge
                    variant={
                      preview.manifest.permissions.code ? "danger" : "outline"
                    }
                  >
                    {t("code")}:{" "}
                    {preview.manifest.permissions.code
                      ? t("enabled")
                      : t("disabled")}
                  </Badge>
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
              disabled={!preview || !confirmed || installing || codeBlocked}
            >
              {installing ? t("installing") : t("installButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
