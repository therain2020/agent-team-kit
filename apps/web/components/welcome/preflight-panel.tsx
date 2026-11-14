import type { PreflightLevel, PreflightReport } from "@kit/bootstrap";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";

const ICONS = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
  info: Info,
} as const;

const COLORS: Record<PreflightLevel, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  fail: "text-red-300",
  info: "text-zinc-500",
};

export async function PreflightPanel({ report }: { report: PreflightReport }) {
  const t = await getTranslations("welcome");

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-5">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[12px] font-medium text-zinc-200">
          {t("preflightTitle")}
        </h2>
        <span className="font-mono text-[10px] text-zinc-500">
          {t("preflightMode", { mode: report.mode })}
        </span>
      </header>

      <ul className="space-y-2.5">
        {report.checks.map((check) => {
          const Icon = ICONS[check.level];
          return (
            <li key={check.id} className="flex items-start gap-2">
              <Icon
                className={`mt-0.5 size-3.5 shrink-0 ${COLORS[check.level]}`}
              />
              <div className="min-w-0 space-y-0.5">
                <p className="text-[11px] text-zinc-300">
                  {t(`check_${check.id.replace(/[:-]/g, "_")}`)}
                </p>
                <p className="break-words font-mono text-[10px] text-zinc-500">
                  {check.detail}
                </p>
                {check.fix && check.level !== "ok" ? (
                  <code className="block break-all rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-zinc-300">
                    {check.fix}
                  </code>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {report.actions.length > 0 ? (
        <div className="rounded-md border border-border bg-background px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("preflightNext")}
          </p>
          <ul className="mt-1 space-y-1">
            {report.actions.map((action) => (
              <li
                key={action}
                className="break-all font-mono text-[11px] text-zinc-300"
              >
                {action}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-emerald-300/80">{t("preflightReady")}</p>
      )}
    </section>
  );
}
