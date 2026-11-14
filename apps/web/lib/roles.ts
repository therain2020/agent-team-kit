import type { AgentRole } from "@kit/core";

export function parseRole(value: unknown): AgentRole {
  return value === "seller" ||
    value === "manager" ||
    value === "specialist" ||
    value === "builder"
    ? value
    : "builder";
}
