# Cold start checklist

Executable record for the first 7 days of a new team. Copy this file into the
tracking PR, issue or ops ticket, fill one row per item, and attach an
evidence locator. An item is only checked when the evidence exists; prose is
not evidence.

- Plan basis: `61-reliability-degradation.md` §3.3/§5; golden set: `40-quality-plane.md` §3.6; G1: `01-foundations.md`
- Package: `templates/cold-start`
- Workspace:
- Operator:
- Window (UTC): `________` to `________` (7 consecutive days)
- Release / PR:

## How to record

1. Keep the cold-start policy from `template.yaml` active for the whole
   window: every stage `approval.mode: required`, class A/C tools require
   per-item approval, `autoApprove.enabled: false`, autonomy level `manual`
   (autopilot off). If the deployment exposes a sampling control, set it to
   100%.
2. After each day, add an Evidence log row and fill one Pass-rate record row.
3. Mark `[x]` only when the pass condition is met **and** the Evidence cell
   has a path, URL or artifact ID. Otherwise leave `[ ]`.
4. Run `bun run cold-start:check` after editing the package; it must report
   `ok`.

## Checklist

| # | Item | Pass condition | Status | Evidence |
|---|------|----------------|--------|----------|
| CS-1 | 7-day continuous run | 7 consecutive days with the stack serving; no unresolved critical incident; scheduler/heartbeat gap does not exceed 30 minutes without a recorded, approved exception | [ ] | _pending: run IDs, date range, uptime or audit locator_ |
| CS-2 | Quality baseline threshold | Baseline evaluation on the golden set reaches every enabled rubric threshold in `evals/visible/rubrics.yaml`; every score carries `artifact_id + version` | [ ] | _pending: eval artifact IDs and versions_ |
| CS-3 | Sampling/approval policy active | Cold-start policy in force for the full window: every stage requires approval, class A and C tools require per-item approval, auto-approval disabled, autopilot off; sampling at 100% where the deployment supports it | [ ] | _pending: config snapshot and audit event locator_ |
| CS-4 | Budget guardrails | `budget.yaml` applied: daily and monthly CNY plus per-run caps; spend and run counts stay within caps for the full window | [ ] | _pending: budget config and spend report locator_ |
| CS-5 | Recovery drill | Kill-switch and recovery drill run against this deployment; recovery completes within the declared deadline and the audit trail is present | [ ] | _pending: `recovery-drill-<stamp>.json` and audit entries_ |
| CS-6 | Cold-start first-pass rate | First-pass rate over the 7-day window is at least 90% (plan `61` §5), computed from the Pass-rate record below | [ ] | _pending: attempts, first-pass count, computed rate_ |

## Evidence log

Append one row per piece of evidence. Keep locators stable (repository path,
artifact ID with version, or a durable URL).

| Captured at (UTC) | Item | Evidence type | Locator | Notes / hash |
|---|---|---|---|---|
| _pending_ | _CS-_ | _run / eval / config / drill / spend_ | _path, URL or artifact ID_ | _optional_ |

## Pass-rate record

One row per day. A run counts as first-pass only if it succeeds without a
revision, retry or manual repair after the initial attempt.

| Day (UTC) | Runs | First-pass runs | Rate | Notes |
|---|---|---|---|---|
| Day 1 | | | | |
| Day 2 | | | | |
| Day 3 | | | | |
| Day 4 | | | | |
| Day 5 | | | | |
| Day 6 | | | | |
| Day 7 | | | | |
| **Total** | | | | |

- Threshold: >= 90% (plan `61` §5)
- Computed rate: `____ / ____ = ____%` (fill from real runs only)

## Sign-off

- [ ] Operator sign-off — name, date, evidence log reviewed
- [ ] Reviewer sign-off — name, date, pass-rate arithmetic checked
- [ ] Policy relaxation decision recorded — issue or PR link; only allowed
      after CS-1 through CS-6 are all checked

## Notes and exceptions

Record any exception, incident or approved deviation here with its evidence
locator. An unresolved exception keeps the cold start open.
