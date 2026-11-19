# Baseline evaluation checklist

Run this before the first live cold-start run and re-run it whenever the
rubric, golden set, model or workflow changes during the window. The goal is
a reproducible baseline, not a good-looking number.

- Pack / workflow:
- Rubric: `evals/rubrics.yaml` (record the file hash)
- Golden set: `golden-set.yaml` (record the file hash)
- Evaluator model:
- Run mode: `DRY_RUN` (non-LIVE scores never enter a formal quality conclusion)
- Run at (UTC):
- Operator:

## Procedure

1. Freeze inputs: golden set, rubric, fixtures and prompt versions. Record
   their hashes in the evidence log of `CHECKLIST.md`.
2. Run the baseline evaluation over the frozen golden set.
3. For every case, capture the produced artifact ID and version, every
   dimension score, and the evidence references. A score without
   `artifact_id + version` is invalid (plan `40` §2).
4. Compare each dimension against the threshold declared in
   `evals/rubrics.yaml`. Do not round up or drop a failing dimension.
5. Record the aggregate pass/fail and attach the eval artifact IDs in
   `CHECKLIST.md` under `CS-2`.
6. If any enabled dimension is below its threshold, keep the cold start at
   policy level and fix the cause before re-running the baseline. Do not
   relax the rubric to pass.

## Result record

| Dimension | Threshold | Baseline score | Pass | Evidence (eval artifact id + version) |
|---|---|---|---|---|
| _dimension_ | _from rubric_ | _pending_ | [ ] | _pending_ |

Baseline verdict: [ ] pass (all enabled dimensions at or above threshold) /
[ ] fail

Do not write a score here unless it came from an eval run with versioned
evidence.
