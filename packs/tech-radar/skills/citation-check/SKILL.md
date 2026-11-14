---
name: citation-check
description: Verify that every claim carries a resolvable citation and flag unsupported statements.
version: 0.1.0
allowed-tools: [fetch]
---

# Citation Check

Given a draft and an evidence set with `sources[].citationId`:

1. Extract every factual claim.
2. Each claim must cite `[S#]` matching an existing `citationId`.
3. Mark claims with missing or unknown citation IDs as `unsupported`.
4. Verify the draft has a `## Recommendations` section.
5. Return a list of `{ claim, citation, status, reason }`.

Never invent a citation. If a source is unreachable, mark it `unresolved`.
