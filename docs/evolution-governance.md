# Evolution governance: frozen eval snapshots

`kit evolve cycle` freezes the evaluator inputs before it proposes, scores or
promotes anything. The cycle then evaluates the baseline, candidate and canary
only against that frozen copy.

## Snapshot layout

```
<cycles-root>/<cycleId>/eval/
  evals/            # copied from the pack
  fixtures/         # copied when the pack has one
  hidden/           # optional hidden eval set (outside the pack)
  manifest.json     # relative path, sha256 and size for every file
  manifest.sha256   # hash of manifest.json
```

The default root is `%USERPROFILE%\.agent-team-kit\cycles`
(`~/.agent-team-kit/cycles`). Override it with `KIT_EVOLUTION_CYCLES_ROOT` or
`--cycles-root`. The root must live outside the pack and the working tree;
otherwise the cycle refuses to start.

Files are marked read-only where the OS honors POSIX modes. Hash verification is
the hard guard: `scoreVariant` re-verifies the manifest before every score, so
editing the live pack or the snapshot fails the cycle instead of silently
changing the rubric.

## Evaluator changes

`EVALUATOR_VERSION` plus the frozen `evals/` tree form the `evaluatorHash`. A
cycle that sees a different hash from the previous cycle is skipped:

```text
evolve cycle packs/tech-radar --input-file .tmp/evidence.json \
  --approve-evaluator-change --approval-ref <approval-id>
```

The approval reference is stored on the cycle. The change applies only to the
new cycle; earlier snapshots are never rewritten. A skipped cycle does not
create a snapshot, so an unapproved evaluator cannot become the new baseline.

## Verify

```text
kit evolve snapshot verify <cycleId> [--cycles-root <dir>]
```

The command recomputes every file hash and the manifest hash and exits non-zero
on mismatch. Cycle records persist `evalSnapshotPath`, `evalSnapshotHash`,
`evaluatorHash` and, when approved, `evaluatorApprovalRef`.

## Canary

`startCanary` stores `evalSnapshotPath` on the canary state and
`evaluateCanary` reuses it, so manual canary evaluation cannot fall back to a
mutable rubric.

## Follow-ups

- Hidden-set isolation and rotation: E2 (#27).
- Goodhart divergence and drift re-evaluation: E3 (#28).
- Incident freeze and convergence: E4 (#29).
- Safety invariant tests: E6 (#31).
