import type { EventEnvelope, TeamPack } from "@kit/core";

export const testTimestamp = "2026-11-14T00:00:00.000Z";

export function makeEvent(
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: "evt_test",
    type: "demo.event.received",
    schemaVersion: "1.0",
    occurredAt: testTimestamp,
    receivedAt: testTimestamp,
    workspaceId: "default",
    idempotencyKey: "test:key",
    traceId: "trc_test",
    payloadRef: "s3://bucket/key",
    ...overrides,
  };
}

export function makePack(overrides: Partial<TeamPack> = {}): TeamPack {
  return {
    apiVersion: "agentteam/v1",
    kind: "TeamPack",
    metadata: {
      name: "minimal",
      version: "1.0.0",
      compatibility: { kit: ">=0.1 <2.0" },
    },
    agents: [
      {
        id: "echo",
        file: "agents/echo.md",
        model: "deepseek-flash",
        tools: [],
        skills: [],
      },
    ],
    workflows: ["workflows/demo.yaml"],
    policies: [],
    ...overrides,
  };
}
