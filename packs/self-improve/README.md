# self-improve

A task-centric team that applies the Kit to this repository.

## Missions

- **security-audit** — Seller defines acceptance; Cyber Auditor maps the attack
  surface and runs static scans; Patcher writes a sandbox patch and runs checks;
  Verifier independently re-checks; Seller writes the report and requires an
  approval before delivery.
- **ux-improvement** — Seller defines acceptance; UX Researcher inspects code and
  (when `KIT_BROWSE_BIN` is set) the local UI; Frontend Builder writes a sandbox
  patch; Verifier checks regressions; Seller writes the report and requires an
  approval.

## Task-centric iteration (0.9.0)

`iteration.yaml` maps task domains to a workflow, an external coder, an agent
for instructions, and verification checks.

```bash
bun run kit iterate \
  --pack packs/self-improve \
  --goal "Find one security weakness and one UX problem, fix them, verify" \
  --max-tasks 2 --live --apply low
```

Flow: Planner → task plan → external coder (DSH by default) in an isolated
repository copy → `typecheck`/`lint`/`test` → repair with feedback → risk
classify → low-risk apply with commit + backup → report.

- Domains: `cyber` (patcher) and `ux` (frontend-builder).
- `--stub` uses a deterministic security + UX plan; the coder still runs.
- High-risk changes are never auto-applied; they remain pending approval.
- Codex/OpenCode are available through `--coder` and the
  `KIT_CODER_CODEX_CMD` / `KIT_CODER_OPENCODE_CMD` templates.

## Execution boundary (0.9.0)

Agents can **read/search the repository**, run fixed checks
(`typecheck`, `lint`, `test`, `build`), run static security scans, fetch
HTTP(S), inspect a local page through the browser adapter, and write a
**sandbox patch** under `.tmp/workspaces/`.

External coders work on a repository copy and return a transcript, changed
files and a diff. They never write the real repository directly. Low-risk
verified changes can be applied by the iteration workflow with a commit and a
backup; everything else is reviewed or approved.

The recovery kernel (LKG, rollback, audit sink, kill switch) lives outside the
repository. The system may modify all repository code, but it cannot modify the
kernel that restores it.

## Roles

- `seller` — seller
- `patcher`, `frontend-builder` — builder
- `cyber-auditor`, `ux-researcher`, `verifier` — specialist
- `manager` — manager

`roles.allowCombined=false`: one agent cannot fill Seller and Builder at once.
