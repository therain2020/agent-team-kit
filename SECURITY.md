# Security

Agent Team Kit runs agent teams that can read repositories, call tools and apply
changes. We take reports seriously.

## Supported versions

The current preview is `0.9.x`. Security fixes land on the active development
line first; there are no long-term support branches yet.

## Reporting a vulnerability

**Do not open a public issue.**

Use the repository's **Security** tab → **Report a vulnerability** (GitHub private
vulnerability reporting). If that is unavailable, contact a maintainer directly on
GitHub and ask for a private channel before sharing details.

Include:

- affected version and commit;
- a minimal reproduction (commands, pack files, event payloads);
- impact: what an attacker gains, and what they need (local access, a malicious
  source, a malicious pack, a webhook secret, etc.);
- any suggested fix.

We aim to acknowledge reports within a few business days. This is a community
project with no paid support or SLA.

## Scope

In scope:

- escaping the coder sandbox or the workspace write boundary;
- bypassing approvals, risk classification, policy checks or the kill switch;
- forged or replayed gateway signatures, idempotency or webhook handling;
- secret leakage into artifacts, logs, transcripts or error output;
- prompt injection that produces an unauthorized side effect;
- path traversal, SSRF, unsafe rendering of artifact Markdown or HTML;
- supply-chain issues in packs, workshop items or dependencies.

Out of scope (known boundaries, documented in [README.md](./README.md)):

- the Manager Console has no RBAC and is intended for localhost use;
- third-party packs and workshop items are untrusted content until reviewed;
- denial of service against your own local stack;
- issues that require an already-compromised host.

## Safe harbor

We will not pursue legal action for good-faith research that follows this policy,
avoids privacy violations and data destruction, and gives us reasonable time to
fix the issue before public disclosure.
