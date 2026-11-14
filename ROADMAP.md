# Roadmap

> Status: **0.9.0 — autonomy preview**. 1.0 is not claimed yet.

The product bet: a private team of agents you can own, inspect, approve and
improve. Teams are files; runs are auditable; external effects require approval.

## Now — make the first hour work

- [x] `kit bootstrap` — one model key, stored in the OS keychain
- [x] `/welcome` — add a key from the console
- [ ] `kit doctor` — Bun, Node, Docker, ports, keys (this release)
- [ ] `kit demo` — a demo team and a static plan without Docker (this release)
- [x] Templates resolve from the package, not just the repo checkout
- [ ] Console error boundaries and backend-down guidance
- [ ] Zero-config local runtime (embedded database and runner; no Docker)
- [ ] Bilingual onboarding: templates, generated files, browser language

## Next — the last mile

- [ ] Delivery adapters: email, chat webhook, static site publish
- [ ] Share links for artifacts, with provenance and redaction
- [ ] `/workshop` gallery: browse, preview and install community teams
- [ ] "Describe a team" → generated template preview → confirm
- [ ] One command from clone to an approved artifact

## Then — organizations can trust it

- [ ] Minimal RBAC: viewer, reviewer, approver, operator, admin
- [ ] Audit export and actor attribution in approvals
- [ ] Deployment recipe for managed Postgres and S3
- [ ] Adoption playbook: pilot workflow, approval mapping, business KPIs
- [ ] A 30-day unattended reference case with public evidence

## 1.0 gate — unattended autonomy

1.0 means: a goal and budget go in; tasks are planned and executed; low-risk
changes land automatically after independent checks; the operator only handles
high-risk approval and release confirmation; self-improvement is proposed,
evaluated and reversible.

The system must run without an operator for the acceptance window, survive a bad
self-change through the external recovery kernel, and leave an auditable trail.
Until that is demonstrated, the version stays below 1.0.

## Community milestones

- Issue and PR templates, CI and pack validation on pull requests
- `good first issue` tasks for entry fixes, docs, translations and packs
- A recurring team-pack challenge, with community teams featured in the workshop
- Translations: Chinese and English first; more languages by contribution
- A public, privacy-friendly demo console (stub model, seeded data)

## Non-goals for now

- Hosted multi-tenant SaaS
- Signed third-party pack marketplace
- Real-time streaming pipelines
- Replacing Temporal/NATS/Postgres in the scale mode (local mode is a thin subset)
