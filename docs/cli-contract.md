# CLI machine-readable contract

Source of truth: `packages/core/src/cli-contract.ts` (plan `91-zero-config.md` §3.6).
The table below is checked by `apps/cli/test/cli-contract.test.ts`; keep them in sync.

The first-class caller of `kit` is an agent, not a human. When `--json` is set,
every command prints exactly one JSON document (streaming commands such as
`kit watch` print one document per line, NDJSON).

## Output envelope

Success:

```json
{ "ok": true, "data": { "...": "command-specific payload" } }
```

Failure:

```json
{
  "ok": false,
  "error": { "code": "not_found", "message": "run not found: run_…", "hint": "optional next step" }
}
```

Without `--json`, human output is unchanged.

## Exit codes

| code                  | exit | meaning                                      |
| --------------------- | ---- | -------------------------------------------- |
| (success)             | 0    | command completed                            |
| `usage`               | 2    | argument or input is invalid                 |
| `not_found`           | 3    | referenced object does not exist             |
| `conflict`            | 4    | state conflict or version mismatch           |
| `permission`          | 5    | permission denied                            |
| `budget`              | 6    | budget or quota exhausted                    |
| `dependency_unavailable` | 7 | a required dependency is unavailable         |
| `internal`            | 8    | unexpected internal error                    |
| `needs_confirmation`  | 5    | explicit `--yes` required (non-interactive)  |

Commands never call `process.exit(n)` with an ad-hoc number. Thrown errors are
classified by `classifyError` and mapped through `exitCodeForCode`.

## Non-interactive rule

No command may wait for stdin. Operations that would prompt on a TTY (publish,
third-party installs) require `--yes`; without it they fail with
`error.code = needs_confirmation`.

## Resumable event cursor

`kit watch --after <seq> --json` tails `activity_events` ordered by the
monotonic `event_id`. Each line is an envelope whose `data.eventId` is the next
cursor. After an interruption, resume with `--after <last eventId>`; the stream
is at-most-once per cursor and never skips or reorders events.

```bash
kit watch --after 0 --json --once          # one batch, then exit (tests/agents)
kit watch --after 42 --limit 200 --json    # continuous NDJSON tail
```

## Idempotency

Write commands accept `--idempotency-key`. Where an idempotency ledger exists
(iteration `dedupeKey`, approval `requestId`), the key flows into it. Elsewhere
it is echoed back in `data` so callers can detect that the key was accepted;
persisted idempotency is tracked by the op-log ledger issue and is not yet
available for those commands.
