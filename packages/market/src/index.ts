/**
 * `@kit/market` — the single market kernel for the open workshop (plan 88
 * §3.4/§6.1 M1, D-69).
 *
 * It owns the mechanics every asset type shares — GitHub search, commit
 * pinning, raw manifest reads, Ed25519 trust grading, secret scanning and
 * atomic install/record writing — with no knowledge of a specific manifest
 * schema. `@kit/workshop` and `@kit/source` are adapters on top of it.
 */

export * from "./github";
export * from "./hash";
export * from "./secrets";
export * from "./trust";
export * from "./search";
export * from "./install";
