# Console IA and route migration

The console exposes **six first-class entries**. Everything else is a
drill-down from one of them, or a legacy route kept alive as a temporary
redirect. This page is the reference for "where did that page go?".

Plan basis: `82-manager-console.md` §3 (information architecture) and issue
#160.

## First-class entries

| Entry | Route | Absorbs |
|---|---|---|
| **Office** | `/office` | Pixel world; Manager chat as a side panel (`?panel=manager`), not a page. |
| **World** | `/world` | Command Center + Runs + Iterations + Activity as one live surface; run drill-down is the `?run=<id>` drawer. |
| **Approvals** | `/approvals` | Inbox (`?request=<id>` drawer) + Factory (`?view=factory`), one surface with the only sidebar badge. |
| **Workshop** | `/workshop` | Packs + Sources + Workshop; new-pack wizard opens in a dialog (`?new=1`), editing continues in Studio. |
| **Evolution** | `/evolution` | Variants, canary, promotion. |
| **Ops** | `/ops` | Ops + Degradation + Budgets + Kill switch + Autopilot as sections (`?section=`). |

## Drill-downs (not in the sidebar)

- `/packs/[dirName]/studio` — Pack Studio, reached from Workshop.
- `/traces` — Jaeger/Temporal deep links for one run, reached from the World
  drawer. Never a sidebar or palette entry.

`g`-prefix quick jumps: press `g` then the entry letter — `o` Office,
`w` World, `a` Approvals, `s` Workshop, `e` Evolution, `p` Ops. The same
chords are shown and searchable in the command palette (`⌘K` / `Ctrl K`).

## Route migration table

Old bookmarks redirect to the consolidated surface. Redirects are temporary
(307) so they can be retired after a release.

| Old route | New home |
|---|---|
| `/` | `/world` |
| `/runs` | `/world?tab=runs` |
| `/runs/:runId` | `/world?run=:runId` |
| `/iterations` | `/world?tab=iterations` |
| `/iterations/:iterationId` | `/world?run=:iterationId` |
| `/activity` | `/world?tab=activity` |
| `/inbox` | `/approvals` |
| `/inbox/:requestId` | `/approvals?request=:requestId` |
| `/factory` | `/approvals?view=factory` |
| `/manager` | `/office?panel=manager` |
| `/packs` | `/workshop?tab=packs` |
| `/packs/new` | `/workshop?new=1` |
| `/packs/:dirName` | `/workshop?pack=:dirName` |
| `/sources` | `/workshop?tab=sources` |
| `/autopilot` | `/ops?section=control` |
| `/degradation` | `/ops?section=degradation` |
| `/budgets` | `/ops?section=budget` |
| `/kill-switch` | `/ops?section=control` |

The table lives in code at `apps/web/lib/legacy-redirects.ts`; `next.config.ts`
feeds it to Next and `apps/web/test/nav.test.ts` asserts every entry lands on a
live route and that `app/(console)` stays at eight page routes or fewer.
