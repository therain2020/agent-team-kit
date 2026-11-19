"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LkgView } from "@/lib/lkg";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

export function LkgCard({ entries }: { entries: LkgView[] }) {
  const t = useTranslations("degradation");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-400" />
          {t("lkgTitle")}
        </CardTitle>
        <Badge variant="outline">{entries.length}</Badge>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-[11px] text-zinc-500">{t("lkgEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li
                key={entry.lkgId}
                className="rounded-lg border border-border px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      entry.verification.state === "verified"
                        ? "success"
                        : "danger"
                    }
                  >
                    {entry.verification.state === "verified"
                      ? t("lkgVerified")
                      : t("lkgStale")}
                  </Badge>
                  <span className="font-mono text-[11px] text-zinc-200">
                    {entry.targetKey}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-zinc-600">
                    {entry.verifiedAt}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[10px] text-zinc-400">
                  {entry.artifactRefs
                    .map((ref) => `${ref.artifactId}@${ref.version}`)
                    .join(" · ")}
                </p>
                <p className="mt-1 text-[10px] text-zinc-500">
                  {t("lkgVerifier", { verifier: entry.verifier })} ·{" "}
                  {t("lkgExpires", { expires: entry.verification.expiresAt })}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10px] text-zinc-500">{t("lkgNote")}</p>
      </CardContent>
    </Card>
  );
}
