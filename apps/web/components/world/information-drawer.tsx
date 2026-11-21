import { ProfileEditor } from "@/components/information/profile-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInformationView } from "@/lib/information";
import { timeAgo } from "@/lib/utils";
import { Activity, Globe2, ShieldAlert, Sparkles, X } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { DrawerShell } from "./drawer-shell";

/**
 * Information drawer on `/world?tab=information` (98 §3.2/§3.5, issue #128).
 *
 * Shows the current InterestProfile, its version history and audit trail, the
 * D-64 profile editor, and recent events with their signal scores and readable
 * reasons. Conflict/injection flags are surfaced here instead of being hidden.
 */
export async function InformationDrawer({
  closeHref,
}: {
  closeHref: string;
}) {
  const [t, common, locale, view] = await Promise.all([
    getTranslations("information"),
    getTranslations("common"),
    getLocale(),
    loadInformationView(),
  ]);

  return (
    <DrawerShell
      closeHref={closeHref}
      label={t("drawerTitle")}
      closeLabel={common("close")}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("eyebrow")}
          </p>
          <h2 className="text-sm font-semibold text-zinc-100">
            {t("drawerTitle")}
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">{t("drawerHint")}</p>
        </div>
        <Link
          href={closeHref}
          aria-label={common("close")}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-200"
        >
          <X className="size-4" />
        </Link>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Globe2 className="size-3.5 text-sky-400" />
              {t("currentProfile")}
            </CardTitle>
            <Badge variant={view.persisted ? "violet" : "outline"}>
              {view.persisted
                ? t("versionBadge", { version: view.profile.version })
                : t("defaultProfile")}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1 text-[11px] text-zinc-400">
            <p>
              <span className="text-zinc-500">{t("topics")}:</span>{" "}
              {view.profile.topics.join(", ") || "—"}
            </p>
            <p>
              <span className="text-zinc-500">{t("entities")}:</span>{" "}
              {view.profile.entities.join(", ") || "—"}
            </p>
            <p>
              <span className="text-zinc-500">{t("exclusions")}:</span>{" "}
              {view.profile.exclusions.join(", ") || "—"}
            </p>
            <p className="font-mono text-[10px]">
              {t("thresholdsLine", {
                relevance: view.profile.thresholds.relevance,
                novelty: view.profile.thresholds.novelty,
                urgency: view.profile.thresholds.urgency,
              })}
            </p>
            <p className="font-mono text-[10px]">
              {t("budgetLine", { value: view.profile.dailyBudgetCny })}
            </p>
            <p className="text-[10px] text-zinc-500">
              {view.profile.rationale}
            </p>
          </CardContent>
        </Card>

        <ProfileEditor
          initialProfile={view.profile}
          persisted={view.persisted}
        />

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Activity className="size-3.5 text-emerald-400" />
              {t("eventsTitle")}
            </CardTitle>
            <Badge variant="outline">
              {t("eventCount", { count: view.events.length })}
            </Badge>
          </CardHeader>
          <CardContent>
            {view.events.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("noEvents")}</p>
            ) : (
              <ul className="space-y-2">
                {view.events.map((event) => {
                  const signals = event.payload.signals;
                  return (
                    <li
                      key={event.eventId}
                      className="rounded-lg border border-border px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[11px] text-zinc-200">
                          {event.title || event.eventId}
                        </span>
                        <Badge variant="outline">{event.sourceId}</Badge>
                        <span className="ml-auto font-mono text-[9px] text-zinc-600">
                          {timeAgo(event.occurredAt, locale)}
                        </span>
                      </div>
                      {signals ? (
                        <>
                          <p className="mt-1 font-mono text-[10px] text-zinc-400">
                            {t("scoresLine", {
                              relevance: signals.relevance,
                              novelty: signals.novelty,
                              urgency: signals.urgency,
                              risk: signals.risk,
                              confidence: signals.confidence,
                            })}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <Badge variant="outline">
                              {t("modelLabel", { model: signals.model })}
                            </Badge>
                            <Badge variant="outline">
                              {t("profileVersionShort", {
                                version: signals.profileVersion,
                              })}
                            </Badge>
                            <Badge
                              variant={signals.passes ? "success" : "outline"}
                            >
                              {signals.passes
                                ? t("passes")
                                : t("belowThreshold")}
                            </Badge>
                            {signals.flags.map((flag) => (
                              <Badge
                                key={flag}
                                variant={
                                  flag === "injection-suspected"
                                    ? "danger"
                                    : flag === "conflict"
                                      ? "warning"
                                      : "outline"
                                }
                              >
                                {flag}
                              </Badge>
                            ))}
                          </div>
                          <ul className="mt-1 space-y-0.5 text-[9px] leading-relaxed text-zinc-500">
                            {signals.reasons
                              .slice(0, 6)
                              .map((reason, index) => (
                                <li key={`${index}-${reason}`}>· {reason}</li>
                              ))}
                          </ul>
                        </>
                      ) : (
                        <p className="mt-1 text-[10px] text-zinc-600">
                          {t("unscored")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs">
              <ShieldAlert className="size-3.5 text-amber-400" />
              {t("auditTitle")}
            </CardTitle>
            <Badge variant="outline">
              {t("auditCount", { count: view.signals.length })}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1 text-[10px] text-zinc-500">
            <p>{t("auditHint")}</p>
            {view.signals.length === 0 ? (
              <p>{t("noAudit")}</p>
            ) : (
              <p>
                {t("auditSummary", {
                  withReasons: view.signals.filter(
                    (row) => row.reasons.length > 0,
                  ).length,
                  total: view.signals.length,
                })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xs">
              <Sparkles className="size-3.5 text-violet-400" />
              {t("historyTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-[10px] text-zinc-500">
            {view.audit.length === 0 ? (
              <p>{t("noHistory")}</p>
            ) : (
              <ul className="space-y-1.5">
                {view.audit.map((entry) => (
                  <li key={entry.auditId}>
                    <span className="font-mono text-zinc-400">
                      v{entry.version} {entry.action}
                    </span>{" "}
                    · {entry.actor} · {timeAgo(entry.occurredAt, locale)}
                    <p className="text-zinc-500">{entry.rationale}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </DrawerShell>
  );
}
