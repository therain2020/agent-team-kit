## Linked issue

Closes #

<!-- Exactly one issue. If this PR needs several, split it. Target branch: develop. -->

## Plan reference

<!-- Plan file and section, e.g. `61-reliability-degradation.md §3.5`. Required for plan-driven work. -->

## What and why

<!-- One paragraph. What changed, and which user moment it improves. -->

## Input surface (D-64)

<!-- Every form, dialog or prompt follows D-64: intent → AI draft → edit → approve. Delete this section if the PR touches no user input surface. -->

- [ ] This PR adds or changes no user input surface (otherwise complete the items below).
- [ ] The surface uses a compose kind and posts through `POST /api/compose`.
- [ ] It has a deterministic fallback (`model: heuristic`) when the model is unavailable.
- [ ] The flow is intent → draft → edit → approve, and nothing is written before approval.

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs / translations
- [ ] Team pack or template
- [ ] Tooling / CI
- [ ] Refactor (no behavior change)

## Verification

<!-- Paste the commands you ran and their result. -->

```bash
bun run typecheck
bun run lint
bun run test
# for pack changes:
bun run kit pack validate <dir>
bun run kit pack simulate <dir>
```

## Plan deviations

<!-- What differs from the plan, and where the plan was updated to record it. Delete if none. -->

## UI evidence

<!-- Screenshots or a short clip for console changes. Delete if not applicable. -->

## Checklist

- [ ] This PR closes exactly one issue, links its plan reference, and targets `develop`.
- [ ] I updated the plan's status and decisions where behavior deviated.
- [ ] I did not include API keys, tokens, connection strings or private data.
- [ ] I added or updated tests for behavior changes.
- [ ] I updated the docs or translations that this change affects.
- [ ] For pack/template changes: it validates, and `README.md` explains the use case.
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md).
