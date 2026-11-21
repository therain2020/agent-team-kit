/**
 * Security invariants live in `@kit/core` because every plane enforces the same
 * contract: pack instruction writes, iteration apply, promotion and runtime
 * routing. This module keeps the evolution-plane import path stable.
 */
export * from "@kit/core/security-invariants";
