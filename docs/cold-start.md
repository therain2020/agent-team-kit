# Cold start

A cold start is the first 7 days of a new team. The package in
[`templates/cold-start/`](../templates/cold-start) makes that window explicit:
a conservative template, the artifacts needed before the first live run, and
an executable checklist with evidence. The closing criteria are a continuous
7-day run and a first-pass rate of at least 90% (plan `61` §5).

## Package

- [`README.md`](../templates/cold-start/README.md) — inventory and usage.
- [`template.yaml`](../templates/cold-start/template.yaml) — conservative
  policy: every stage requires approval, class A/C tools require per-item
  approval, autopilot and self-evolution are off (autonomy level `manual`).
- [`golden-set.yaml`](../templates/cold-start/golden-set.yaml) — golden-set
  skeleton using the `40` contract (`case_id`, `tenant_id`, `input_refs`,
  `expected_refs`, `approved_by`). Structure only; no scores.
- [`baseline-eval.md`](../templates/cold-start/baseline-eval.md) — reproducible
  baseline evaluation against the pack's rubric thresholds.
- [`seed-artifacts.yaml`](../templates/cold-start/seed-artifacts.yaml) —
  artifacts a workspace must have before the first live run.
- [`sources.yaml`](../templates/cold-start/sources.yaml) — source inventory
  with owner and cadence.
- [`budget.yaml`](../templates/cold-start/budget.yaml) — daily/monthly CNY and
  per-run caps.
- [`CHECKLIST.md`](../templates/cold-start/CHECKLIST.md) — the record.

## Flow

1. Create the team: `bun run kit init <dir> --template cold-start`.
2. Fill the golden set with 50-200 human-approved cases (`40` §3.6). Never
   invent cases, scores or thresholds.
3. Fill sources, seed artifacts and budget for the deployment; keep the budget
   at or below the conservative defaults.
4. Run the baseline evaluation and attach the eval artifact IDs/versions.
5. Open the cold start: copy `CHECKLIST.md` into the tracking PR or ops
   ticket, keep the conservative policy active, and record evidence daily.
6. Close the window by filling the pass-rate record. Relax the policy only
   when CS-1 through CS-6 are checked with evidence and the decision is
   recorded.

## Evidence flow

- Evidence is a path, durable URL or artifact ID (with version), captured in
  the `Evidence` column and the Evidence log of `CHECKLIST.md`.
- Scores are valid only with `artifact_id + version` (plan `40` §2).
- The daily Pass-rate record feeds CS-6; compute it from real runs only.
- Run `bun run cold-start:check` to confirm the package still has every
  required file and field (`--json` for machine-readable output).

## Boundaries

This guide and package do not change runtime behavior. The 7-day continuous
run and the >= 90% first-pass rate are operational acceptance evidence; they
are attached to `CHECKLIST.md` later and are not claimed by the package PR.
For degradation and recovery behavior see [degradation.md](./degradation.md)
and [kill-switch.md](./kill-switch.md).
