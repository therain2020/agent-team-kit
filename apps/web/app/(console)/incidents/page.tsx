import { PageHeader } from "@/components/kit/page-header";
import { loadIncidentOverview } from "@/lib/incident";
import { RPO_TARGET_MINUTES, RTO_TARGET_MINUTES } from "@kit/core";

export const dynamic = "force-dynamic";

const MODE = "font-mono text-[11px]";
const HEADING =
  "font-mono text-[12px] font-bold tracking-[0.1em] text-px-strong uppercase";
const PASS =
  "mt-1 inline-block border border-emerald-700 px-1 text-emerald-300";
const WARN = "mt-1 inline-block border border-amber-700 px-1 text-amber-300";

function coverageLabel(
  covered: boolean,
  missing: boolean,
  undrilled: boolean,
): string {
  if (covered) {
    return "runbook + drill";
  }
  if (missing) {
    return "missing runbook";
  }
  if (undrilled) {
    return "runbook, no drill";
  }
  return "uncovered";
}

export default async function IncidentsPage() {
  const overview = await loadIncidentOverview();
  const { coverage, incidents, runbooks, recoveryDrills, recoveryDrillDue } =
    overview;
  const lastDrill = recoveryDrills[0] ?? null;
  const description = `Postmortem cadence 24h draft / 48h final · recovery drill RTO ${RTO_TARGET_MINUTES}m / RPO ${RPO_TARGET_MINUTES}m, quarterly (D-38)`;
  const lastDrillLine = recoveryDrillDue
    ? "No recovery drill inside the quarterly window"
    : `Last drill ${lastDrill?.executedAt} · ${lastDrill?.outcome} · RTO ${lastDrill?.measuredRtoMinutes ?? "?"}m / RPO ${lastDrill?.measuredRpoMinutes ?? "?"}m`;
  const drillHint =
    "Drills reuse smoke:recovery plus kitd rollback; record with bun run recovery:drill --execute --rpo-minutes <n>.";
  const emptyIncidents = `No incidents recorded for ${overview.workspaceId}.`;
  const emptyRunbooks =
    "No runbooks yet. Seed templates with bun run runbook:drill --execute --seed-runbooks.";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Incidents · Runbooks" description={description} />

      <section className="flex flex-col gap-3">
        <h2 className={HEADING}>Degradation mode coverage</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {coverage.requiredModes.map((mode) => {
            const covered = coverage.coveredModes.includes(mode);
            const missing = coverage.missingModes.includes(mode);
            const undrilled = coverage.undrilledModes.includes(mode);
            const label = coverageLabel(covered, missing, undrilled);
            return (
              <div
                key={mode}
                className="border border-px-line bg-px-panel px-3 py-2 font-mono text-[11px]"
              >
                <div className="text-px-strong">{mode}</div>
                <div className={covered ? PASS : WARN}>{label}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={HEADING}>Recovery drills</h2>
        <div className={recoveryDrillDue ? WARN : PASS}>{lastDrillLine}</div>
        <p className={`text-px-muted ${MODE}`}>{drillHint}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={HEADING}>Incidents</h2>
        {incidents.length === 0 ? (
          <p className={`text-px-muted ${MODE}`}>{emptyIncidents}</p>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead>
              <tr className="border-b border-px-line text-left text-px-muted">
                <th className="py-1 pr-3">severity</th>
                <th className="py-1 pr-3">title</th>
                <th className="py-1 pr-3">status</th>
                <th className="py-1 pr-3">owner</th>
                <th className="py-1 pr-3">postmortem</th>
                <th className="py-1">detected</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((incident) => (
                <tr
                  key={incident.incidentId}
                  className="border-b border-px-line/50 text-px-strong"
                >
                  <td className="py-1 pr-3 uppercase">{incident.severity}</td>
                  <td className="py-1 pr-3">{incident.title}</td>
                  <td className="py-1 pr-3">{incident.status}</td>
                  <td className="py-1 pr-3">{incident.owner}</td>
                  <td className="py-1 pr-3">
                    {incident.postmortemState.status}
                    {incident.postmortemState.overdue ? " · overdue" : ""}
                  </td>
                  <td className="py-1">{incident.detectedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={HEADING}>Runbooks</h2>
        {runbooks.length === 0 ? (
          <p className={`text-px-muted ${MODE}`}>{emptyRunbooks}</p>
        ) : (
          <ul className={`flex flex-col gap-1 text-px-strong ${MODE}`}>
            {runbooks.map((runbook) => (
              <li key={runbook.runbookId}>
                {runbook.modeId} · {runbook.status} · {runbook.steps.length}{" "}
                steps · {runbook.verification.length} checks · owner{" "}
                {runbook.owner}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
