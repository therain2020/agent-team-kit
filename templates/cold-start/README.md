# Cold start package

A start package for the first 7 days of a new team. It pairs a conservative
team template with the artifacts an operator needs before the first live run:
a golden-set skeleton, a baseline evaluation checklist, seed artifacts, a
source list and a budget. The executable record of the window lives in
[`CHECKLIST.md`](./CHECKLIST.md).

The package is intentionally incomplete. Golden cases, scores and evidence
are blank on purpose: they must come from real, human-approved work, never
from the template.

## Contents

| File | Purpose |
|---|---|
| `template.yaml` | Conservative team template: every stage requires approval, class A read tools require approval, autopilot and evolution are off (manual autonomy). |
| `golden-set.yaml` | Golden-set skeleton using the `40` contract (`case_id`, `tenant_id`, `input_refs`, `expected_refs`, `approved_by`). Structure only; no scores. |
| `baseline-eval.md` | Baseline evaluation checklist: freeze inputs, run against rubric thresholds, attach versioned evidence. |
| `seed-artifacts.yaml` | Artifacts a new workspace must have before the first live run. |
| `sources.yaml` | Source inventory: name, URL or topic, cadence, owner. |
| `budget.yaml` | Daily and monthly CNY plus per-run caps for the cold-start window. |
| `CHECKLIST.md` | Executable checklist with an Evidence column, daily evidence log, pass-rate record and sign-off. |

## Use

1. Create the team from the template:
   `bun run kit init <dir> --template cold-start`
2. Fill `golden-set.yaml` with 50-200 human-approved cases (plan `40` §3.6).
   Each expected reference points at a versioned artifact. Do not fabricate
   cases or scores.
3. Fill `sources.yaml`, `seed-artifacts.yaml` and `budget.yaml` for the
   deployment. Keep the budget values at or below the conservative defaults
   until the cold start closes.
4. Run the baseline evaluation per `baseline-eval.md` and attach the eval
   artifact IDs and versions.
5. Copy `CHECKLIST.md` into the tracking PR or ops ticket. Keep the
   cold-start policy active for the full 7-day window and append evidence
   daily.
6. Check the package any time with:
   `bun run cold-start:check` (add `--json` for machine-readable output).

## Conservative posture

- Autonomy level: `manual` (`autopilot.enabled: false`) for the entire window.
- Approvals: every stage (`approval.mode: required`), plus per-item approval
  for class A read tools and class C external delivery.
- Auto-approval: disabled (`maxRisk: low`, `onTimeout: wait`).
- Iteration config: one `DRY_RUN` task, `maxRepair: 0`, `applyMode: none`,
  daily run/cost caps mirrored from `budget.yaml`.
- Self-evolution: disabled.
- Sampling: the template schema has no sampling field yet, so 100% review is
  enforced through stage approvals. If the deployment gains sampling, set it
  to 100% for the cold start.

## Boundaries

This package documents and configures the cold start; it does not implement
runtime behavior. The 7-day continuous run and the >= 90% first-pass rate
(plan `61` §5) are operational acceptance criteria. They are recorded in
`CHECKLIST.md` as evidence and must not be claimed from a green PR alone.
