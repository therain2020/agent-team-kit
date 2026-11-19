"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WorkshopInstallRecord } from "@kit/workshop";
import { ArchiveRestore, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const DISMISS_KEY = "kit.workshop.legacy-import-dismissed";

/**
 * One-time prompt for packs that were installed into the legacy `workshop/`
 * directory before packs started landing in `packs/` (plan 88 §3.4). Nothing
 * is copied automatically: the console only offers an explicit import, and the
 * prompt disappears once every listed pack exists in the pack library.
 */
export function LegacyImportBanner({
  records,
}: {
  records: WorkshopInstallRecord[];
}) {
  const t = useTranslations("workshopSurface");
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Storage can be unavailable (private mode); the prompt still shows.
    }
    setReady(true);
  }, []);

  if (!ready || dismissed || records.length === 0) {
    return null;
  }

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage failures; the session-level dismissal still applies.
    }
  }

  async function importPack(record: WorkshopInstallRecord) {
    setPending(record.dirName);
    try {
      const response = await fetch("/api/workshop/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: record.dirName }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("legacyImportFailed"));
      }
      toast.success(t("legacyImportDone", { name: record.name }));
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("legacyImportFailed"),
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[11px] text-amber-100/90">
      <div className="flex items-start gap-2">
        <ArchiveRestore className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t("legacyTitle")}</p>
          <p className="mt-1 text-amber-200/80">{t("legacyDescription")}</p>
          <ul className="mt-2 space-y-1.5">
            {records.map((record) => (
              <li
                key={record.dirName}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-mono text-xs text-zinc-200">
                  {record.name}
                </span>
                <Badge variant="outline">v{record.version}</Badge>
                <span className="font-mono text-[10px] text-zinc-500">
                  {record.repo}@{record.commit.slice(0, 8)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={pending !== null}
                  onClick={() => void importPack(record)}
                >
                  {pending === record.dirName
                    ? t("legacyImporting")
                    : t("legacyImport")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("legacyDismiss")}
          onClick={dismiss}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </section>
  );
}
