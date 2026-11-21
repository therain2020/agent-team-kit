# Compose gate (C-0)

Plan reference: `94-ai-composer.md` §2 rule 6 and §6 (C-0).

Every **new user input surface** must ship with:

1. a compose kind (one of the kinds served by `POST /api/compose`),
2. a deterministic fallback (`model: "heuristic"`) when the model is unavailable,
3. the review step **intent → draft → edit → approve**, with nothing written before approval.

A manual-only form is considered unfinished. The PR checklist alone could not
enforce this, so the declaration is machine-readable and checked in:
[`.github/compose-gate/input-surfaces.json`](../.github/compose-gate/input-surfaces.json).

The manifest is used instead of prose in the PR body because it is versioned,
diffable, auditable after merge, and cannot drift from the code it describes.

## What the check detects

The `compose-gate` CI job fails only when a **changed** file is both (a) in
scope and (b) missing from the manifest. The scope is deliberately narrow so
unrelated PRs never fail:

| In scope | Why |
| --- | --- |
| `apps/web/components/<domain>/<name>-(dialog\|wizard\|form).tsx` | The standard shape of a console input surface. |
| Any `apps/web/**/*.tsx` whose content calls `/api/compose` | A draft surface, whatever its filename. |

Out of scope: `apps/web/components/ui/**` and `apps/web/components/kit/**`
primitives, API routes, pages that do not call `/api/compose`, `packages/**`,
`scripts/**`, `docs/**` and tests. A new in-page form that uses neither the
dialog/wizard/form naming nor `/api/compose` is not detected by the gate and
remains a reviewer responsibility; this is the documented scope limit, chosen
so existing PRs do not break.

Deleting a surface is handled by the staleness check: the manifest entry must
be removed in the same PR, otherwise the gate reports the missing file.

## Manifest entry

```json
{
  "id": "C-2",
  "label": "Office new task",
  "files": ["apps/web/components/office/new-mission-dialog.tsx"],
  "status": "compose",
  "composeKinds": ["mission"],
  "fallback": "heuristic",
  "review": "intent-draft-edit-approve"
}
```

- `composeKinds` — one or more kinds from `packages/job/src/compose.ts`
  (`mission`, `packRun`, `approvalPolicy`, `autopilot`, `evolutionCycle`,
  `agent`, `pack`, `workflow`, `pipeline`, `source`). A unit test keeps this
  list in sync with the API route.
- `fallback` — must be exactly `heuristic` (plan §2 rule 3).
- `review` — must be exactly `intent-draft-edit-approve` (plan §2 rules 1, 4, 6).
- `files` — repo-relative exact paths. No globs, absolute paths or `..`; a file
  may belong to only one surface.

If a surface intentionally stays manual-only, declare it as an exemption with a
written reason instead of pretending it uses compose:

```json
{
  "id": "C-8",
  "label": "Welcome bootstrap",
  "files": ["apps/web/components/welcome/bootstrap-form.tsx"],
  "status": "exempt",
  "reason": "D-64 exception: API key bootstrap is the one hand-filled configuration surface (plan 94 §4 C-8)."
}
```

Exemptions are visible in review; add one only when the plan names the
exception.

## Running the check

```bash
# PR-style diff against the integration branch
bun run compose:gate --base origin/develop

# explicit changed-file list (one path per line)
bun run compose:gate --files changed.txt

# whole-tree audit: every apps/web source file must be declared
bun run compose:gate --audit
```

The CI job runs the base diff on `pull_request` events only. A unit test also
audits the whole tree on every `bun run test`, so the manifest cannot silently
fall behind the code.

## When the gate fails

The failure message lists each undeclared file and prints a declaration
template. To fix it:

1. Add one manifest entry per surface, in the same PR, with its compose kind,
   `"fallback": "heuristic"` and `"review": "intent-draft-edit-approve"`.
2. Or, for a plan-approved exception, use `"status": "exempt"` with a reason.
3. Run `bun run compose:gate --base origin/develop` locally and push the fix.

The check is a tripwire against honest mistakes, not a security boundary: the
gate script itself runs from the PR head. Changes to `scripts/compose-gate.ts`
or the manifest must be reviewed like any other contract change.
