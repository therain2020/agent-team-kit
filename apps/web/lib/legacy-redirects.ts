/**
 * Route migrations for the consolidated console IA (82 §3, issues #160/#164).
 *
 * The console has six first-class entries (Office / World / Approvals /
 * Workshop / Evolution / Ops). Every other route is a drill-down or was folded
 * into one of those surfaces. Old first-class pages keep working as redirects
 * for one release so shared links and bookmarks never 404.
 *
 * Keep this table the single source of truth: `next.config.ts` feeds it to Next
 * and the web tests assert its contents. Order matters — specific paths
 * (`/packs/new`) must precede parameterised siblings (`/packs/:dirName`).
 */
export interface LegacyRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

const TEMPORARY = false;

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  // Command Center folded into the World surface.
  { source: "/", destination: "/world", permanent: TEMPORARY },
  // Runs + Iterations + Activity are tabs/drawers of /world now.
  { source: "/runs", destination: "/world?tab=runs", permanent: TEMPORARY },
  {
    source: "/runs/:runId",
    destination: "/world?run=:runId",
    permanent: TEMPORARY,
  },
  {
    source: "/iterations",
    destination: "/world?tab=iterations",
    permanent: TEMPORARY,
  },
  {
    source: "/iterations/:iterationId",
    destination: "/world?run=:iterationId",
    permanent: TEMPORARY,
  },
  {
    source: "/activity",
    destination: "/world?tab=activity",
    permanent: TEMPORARY,
  },
  // Inbox + Factory are the two views of /approvals.
  { source: "/inbox", destination: "/approvals", permanent: TEMPORARY },
  {
    source: "/inbox/:requestId",
    destination: "/approvals?request=:requestId",
    permanent: TEMPORARY,
  },
  {
    source: "/factory",
    destination: "/approvals?view=factory",
    permanent: TEMPORARY,
  },
  // Manager chat is an Office side panel now (?panel=manager opens it).
  {
    source: "/manager",
    destination: "/office?panel=manager",
    permanent: TEMPORARY,
  },
  // `/packs` and `/sources` are live local libraries again (88 §3.4, D-69):
  // installs land there and the workshop is the discovery center. Only the
  // old pack drill-downs keep redirecting inside the library.
  {
    source: "/packs/new",
    destination: "/packs?new=1",
    permanent: TEMPORARY,
  },
  {
    source: "/packs/:dirName",
    destination: "/packs?pack=:dirName",
    permanent: TEMPORARY,
  },
  // Ops + Degradation + Budgets + Kill switch + Autopilot are /ops sections.
  {
    source: "/autopilot",
    destination: "/ops?section=control",
    permanent: TEMPORARY,
  },
  {
    source: "/degradation",
    destination: "/ops?section=degradation",
    permanent: TEMPORARY,
  },
  {
    source: "/budgets",
    destination: "/ops?section=budget",
    permanent: TEMPORARY,
  },
  {
    source: "/kill-switch",
    destination: "/ops?section=control",
    permanent: TEMPORARY,
  },
];
