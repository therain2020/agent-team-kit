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

## Execution boundary (v1.0)

Agents can **read/search the repository**, run fixed checks
(`typecheck`, `lint`, `test`, `build`), run static security scans, fetch
HTTP(S), inspect a local page through the browser adapter, and write a
**sandbox patch** under `.tmp/workspaces/<runId>`.

They do **not** modify the real repository. Apply a patch manually after
reviewing the `workspace_diff` artifact. External network access is limited to
LIVE runs or `KIT_TOOLS_ALLOW_NETWORK=1`; localhost is allowed unless
`KIT_TOOLS_ALLOW_LOCALHOST=0`. Browser inspection requires `KIT_BROWSE_BIN`.

## Roles

- `seller` — seller
- `patcher`, `frontend-builder` — builder
- `cyber-auditor`, `ux-researcher`, `verifier` — specialist
- `manager` — manager

`roles.allowCombined=false`: one agent cannot fill Seller and Builder at once.
