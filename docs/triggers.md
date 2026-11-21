# Triggers

The trigger plane (`@kit/trigger`) decides **when** work starts. It never builds
or starts a job directly: adapters produce a firing, and `fireTrigger` owns the
gates and the single `@kit/job.startJob` write (plan 96, D-68).

## Objects

| Object | Purpose |
|---|---|
| `Trigger` | `schedule`, `event`, `manual` or `information` declaration |
| `EventRoute` | The job shape one trigger launches (`packRun`, `iteration`; `evolution` is mapped for #95) |
| `TriggerRun` | One firing, one-to-one with a job id, stored in `trigger_runs` |

`fireTrigger({ triggerId, dedupeKey, payloadRef? })` is the only dispatch entry.

## Gate order (D-66, extended by 96 §4)

1. kill switch
2. degraded read-only / night mode
3. dedupe: the same trigger slot, then the same workflow already active
4. trigger budget: UTC-day runs and cost per trigger
5. budget ledger `admitRun`
6. `startJob`
7. `TriggerRun` write-back

A duplicate slot returns `USE_EXISTING` with the original job id; nothing starts
twice. Local and Scale share gates 1–7; only the job engine differs.

## autopilot.yaml

`autopilot.yaml` stays the authoring syntax. The loader maps it once:

- `schedules` → schedule Trigger + `packRun` route
- `iterations` → schedule Trigger + `iteration` route
- `evolution` → schedule Trigger + `evolution` route (execution lands in #95)

The file must keep `version: 1`. Unknown keys, an invalid cron or a malformed
mapping reject the pack with a migration hint instead of silently dropping the
trigger. The runtime keeps no second semantic after loading.

## Manual firing

```bash
kit trigger list
kit trigger fire --trigger daily-radar
kit trigger fire --pack tech-radar --workflow daily-radar
```

A route configured as `LIVE` also requires `--live`, so a manual firing cannot
silently escalate a dry-run trigger.

Ad-hoc firings use `manual:<actor>` as the trigger id and `origin.kind=manual`;
they are not covered by autonomous auto-approval unless the policy uses
`scope: all`. The console exposes the same adapter at `POST /api/triggers`.
