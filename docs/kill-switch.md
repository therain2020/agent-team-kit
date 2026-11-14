# Kill switch

A kill switch stops new execution in a defined scope without deleting state.
It is a safety control, not a cancellation tool: in-flight work pauses, the
glass box and audit trail stay readable, and releasing the switch allows new
runs to start again.

## Scopes

| Scope | Target | Blocks |
|---|---|---|
| `global` | — | Every run and every model/tool call |
| `workspace` | workspace id | Runs and calls in that workspace |
| `agent-source` | agent id | Calls made by that agent (optionally one workspace) |
| `stage` | stage name | Stages with that name (optionally one workspace) |

Resolution priority is `global > workspace > agent-source > stage`. When more
than one switch matches, the broadest one is reported in the audit event and on
the console banner.

## Permissions

| Scope | Who may activate or release |
|---|---|
| `global` | Operator only |
| `workspace` | Operator or a security alert (role `security`) |
| `agent-source` | Operator, security, agent automation, or system |
| `stage` | Operator, security, agent automation, or system |

The CLI defaults to `operator:cli` / `operator`. The console always acts as
`operator:web` / `operator`.

## Checkpoints

The engine checks the active switches at every boundary that can create a side
effect:

1. **run** — before a run is created (`preparePackRun`, `startJob`,
   `enqueueLocalRun`, iteration planning).
2. **stage** — before a stage starts executing.
3. **model** — before every model completion, including gate judges and
   revisions.
4. **tool** — before every tool call, coder task, verification command, and
   repository apply.
5. **delivery** — before an artifact is delivered externally.

A tripped checkpoint throws `KillSwitchTrippedError`, writes a
`kill_switch.tripped` activity event with the checkpoint, scope, target, and
reason, and the pack pipeline sets the run to `paused` instead of `failed`.
Schedulers (Autopilot and the event router) skip starting new work while a
matching switch is active.

> The external recovery kernel (`scripts/kitd.ps1`) still watches
> `~/.agent-team-kit/KILL` and is intentionally not modified here. That file
> switch stops the local stack; the database-backed switches above stop agent
> execution while the console remains usable.

## Audit

Every state change is written to `activity_events` (the glass box feed) and to
the `kill_switches` table:

- `kill_switch.activated` — switch id, scope, target, reason, actor, role,
  version.
- `kill_switch.released` — same fields plus the release reason.
- `kill_switch.tripped` — checkpoint, switch id, scope, target, reason, and the
  matched agent/stage context.

Activation is idempotent: activating an already active identity returns the
existing switch without a second event. Releasing an already released switch is
also a no-op. Reactivating a released identity increments its version.

## CLI

```bash
kit kill-switch list
kit kill-switch activate --scope workspace --workspace default --reason "unsafe output"
kit kill-switch activate --scope agent-source --target writer --reason "bad prompt"
kit kill-switch activate --scope stage --target publish --workspace default --reason "hold publishing"
kit kill-switch release <switchId> --reason "root cause fixed"
```

`--role security|agent|system` is available for automated callers. Global
activation still requires `--role operator`.

## Console and API

- Console: `/kill-switch` shows active and recent switches with version,
  activation/release timestamps, and reasons. Activation requires a reason and
  an explicit confirmation checkbox. A red banner appears under the top bar
  whenever any switch is active.
- `GET /api/kill-switch` returns `{ active, recent }`.
- `POST /api/kill-switch` accepts:

```json
{ "action": "activate", "scope": "stage", "target": "publish",
  "workspaceId": "default", "reason": "hold publishing", "confirm": true }
```

```json
{ "action": "release", "switchId": "kill_...", "reason": "fixed",
  "confirm": true }
```

Mutations require a same-origin request and `confirm: true`.

## Drill runbook

1. Pick a non-production workspace and note a run you can repeat.
2. Activate `workspace` with a reason. Confirm the banner appears and the
   `/activity` feed contains `kill_switch.activated`.
3. Start the run. It must not start (or must pause at the first checkpoint).
   The audit feed must contain `kill_switch.tripped`.
4. While active, confirm `/kill-switch` still lists state (read-only paths keep
   working).
5. Release the switch with a reason. Confirm `kill_switch.released` is in the
   feed and a new run starts normally.
6. Repeat for `global`, `agent-source`, and `stage`, verifying that only the
   intended scope is blocked.

## Recovery

- Find the switch: `kit kill-switch list`.
- Fix the root cause first; do not release a switch to clear a symptom.
- Release with a reason: `kit kill-switch release <switchId> --reason "..."`.
- Paused runs do not resume automatically. Start a new run after release; use
  the glass box to compare artifacts and cost from the paused attempt.
- If the database-backed control plane is unavailable, use the external
  `~/.agent-team-kit/KILL` file and `kitd` to stop the stack, then investigate.
