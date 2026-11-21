import { describe, expect, it, vi } from "vitest";
import {
  type CostCallRecord,
  CostTrackingGateway,
  DEFAULT_PRICE_TABLE,
  type ModelGateway,
  StubModelGateway,
  calculateCostCny,
  computeCostMicro,
  findSupersededPriceVersions,
  loadPriceTable,
  resolveCostScope,
  resolveModelPrice,
} from "../src/index";

const VERSIONED_TABLE = {
  version: "2026-12-01",
  effectiveAt: "2026-12-01T00:00:00.000Z",
  entries: [
    {
      modelId: "deepseek-flash",
      provider: "deepseek",
      currency: "CNY" as const,
      inputPer1k: 0.001,
      outputPer1k: 0.002,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
    {
      modelId: "deepseek-flash",
      provider: "deepseek",
      currency: "CNY" as const,
      inputPer1k: 0.003,
      outputPer1k: 0.006,
      effectiveAt: "2026-12-01T00:00:00.000Z",
    },
  ],
};

describe("price table", () => {
  it("resolves the bundled table with a version and effective date", () => {
    const table = loadPriceTable({});
    const price = resolveModelPrice(
      table,
      "deepseek-pro",
      "2026-11-20T00:00:00.000Z",
    );
    expect(price.tracked).toBe(true);
    expect(price.priceVersion).toBe(DEFAULT_PRICE_TABLE.version);
    expect(price.provider).toBe("deepseek");
    expect(price.inputPer1k).toBe(0.002);
    expect(price.outputPer1k).toBe(0.008);
  });

  it("converts tokens to micro-CNY at the resolved unit price", () => {
    const price = resolveModelPrice(
      DEFAULT_PRICE_TABLE,
      "deepseek-flash",
      "2026-11-20T00:00:00.000Z",
    );
    // 1,000 in @ 0.001 + 1,000 out @ 0.002 = 0.003 CNY = 3000 micro
    expect(computeCostMicro(price, 1000, 1000)).toBe(3000);
    expect(computeCostMicro(price, 0, 0)).toBe(0);
  });

  it("picks the entry effective at the call time and stamps its prices", () => {
    const before = resolveModelPrice(
      VERSIONED_TABLE,
      "deepseek-flash",
      "2026-11-20T00:00:00.000Z",
    );
    const after = resolveModelPrice(
      VERSIONED_TABLE,
      "deepseek-flash",
      "2026-12-05T00:00:00.000Z",
    );
    expect(before.inputPer1k).toBe(0.001);
    expect(before.priceVersion).toBe("2026-12-01");
    expect(after.inputPer1k).toBe(0.003);
    expect(computeCostMicro(before, 1000, 0)).toBe(1000);
    expect(computeCostMicro(after, 1000, 0)).toBe(3000);
  });

  it("marks unknown models untracked instead of pricing them at zero", () => {
    const at = new Date("2026-11-20T00:00:00.000Z");
    const price = resolveModelPrice(DEFAULT_PRICE_TABLE, "mystery-model", at);
    expect(price.tracked).toBe(false);
    expect(price.inputPer1k).toBe(0);
    expect(price.untrackedReason).toContain("mystery-model");
    // Estimates stay 0 (nothing to reserve); recording carries `tracked:false`.
    expect(
      calculateCostCny("mystery-model", 1000, 1000, DEFAULT_PRICE_TABLE, at),
    ).toBe(0);
  });

  it("accepts a full price table override from the environment", () => {
    const table = loadPriceTable({
      KIT_PRICE_TABLE_JSON: JSON.stringify(VERSIONED_TABLE),
    });
    expect(table.version).toBe("2026-12-01");
    expect(table.entries).toHaveLength(2);
  });

  it("rejects a malformed price table override instead of silently zeroing", () => {
    expect(() => loadPriceTable({ KIT_PRICE_TABLE_JSON: "{not json" })).toThrow(
      /KIT_PRICE_TABLE_JSON/,
    );
    expect(() =>
      loadPriceTable({
        KIT_PRICE_TABLE_JSON: JSON.stringify({ version: "", entries: [] }),
      }),
    ).toThrow(/version/);
  });
});

describe("price table change detection", () => {
  const versions = [
    {
      version: "2026-11-01",
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
    {
      version: "2026-12-01",
      effectiveAt: "2026-12-01T00:00:00.000Z",
    },
  ];

  it("reports an old version once a newer one takes effect", () => {
    const changes = findSupersededPriceVersions(
      versions,
      "2026-12-02T00:00:00.000Z",
    );
    expect(changes).toEqual([
      {
        previousVersion: "2026-11-01",
        previousEffectiveAt: "2026-11-01T00:00:00.000Z",
        currentVersion: "2026-12-01",
        currentEffectiveAt: "2026-12-01T00:00:00.000Z",
      },
    ]);
  });

  it("ignores versions that are still in effect or not yet active", () => {
    expect(
      findSupersededPriceVersions(versions, "2026-11-20T00:00:00.000Z"),
    ).toEqual([]);
    // Before the first version, nothing has taken effect at all.
    expect(
      findSupersededPriceVersions(versions, "2026-10-01T00:00:00.000Z"),
    ).toEqual([]);
  });
});

describe("cost scope", () => {
  it("keeps run-scoped attribution unchanged", () => {
    expect(
      resolveCostScope({ workspaceId: "default", runId: "run_1" }),
    ).toEqual({ kind: "run", id: "run_1", runId: "run_1" });
  });

  it("derives non-run scopes from aggregate keys", () => {
    expect(
      resolveCostScope({ workspaceId: "default", jobId: "job_1" }),
    ).toEqual({ kind: "job", id: "job_1", runId: "job:job_1" });
    expect(
      resolveCostScope({ workspaceId: "default", changeId: "cyc_1" }),
    ).toEqual({ kind: "evolution", id: "cyc_1", runId: "evolution:cyc_1" });
    expect(
      resolveCostScope({ workspaceId: "default", managerSessionId: "run_2" }),
    ).toEqual({ kind: "manager", id: "run_2", runId: "manager:run_2" });
  });

  it("prefers an explicit scope and rejects unattributed calls", () => {
    expect(
      resolveCostScope({
        workspaceId: "default",
        scopeKind: "manager",
        scopeId: "sess_1",
        runId: "run_1",
      }),
    ).toEqual({ kind: "manager", id: "sess_1", runId: "run_1" });
    expect(() => resolveCostScope({ workspaceId: "default" })).toThrow(
      /requires a runId/,
    );
  });
});

describe("CostTrackingGateway", () => {
  const baseGateway: ModelGateway = {
    complete: vi.fn(async () => ({
      text: "ok",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        modelId: "deepseek-flash",
        provider: "deepseek",
        unitPriceIn: 0.001,
        unitPriceOut: 0.002,
        priceVersion: "2026-11-01",
        tracked: true,
      },
    })),
    completeWithTools: vi.fn(async () => ({
      text: "ok",
      toolCalls: [],
      message: { role: "assistant" as const, content: "ok" },
      usage: {
        inputTokens: 2000,
        outputTokens: 0,
        modelId: "deepseek-pro",
        provider: "deepseek",
        unitPriceIn: 0.002,
        unitPriceOut: 0.008,
        priceVersion: "2026-11-01",
        tracked: true,
      },
    })),
  };

  it("records every completion with attribution and stamped prices", async () => {
    const records: CostCallRecord[] = [];
    const gateway = new CostTrackingGateway(baseGateway, {
      context: {
        workspaceId: "default",
        runId: "run_1",
        stageId: "run_1:s1",
        agentId: "writer",
      },
      sink: { record: (record) => records.push(record) },
      now: () => new Date("2026-11-20T10:00:00.000Z"),
      callIdPrefix: "run_1:s1:writer",
    });
    await gateway.complete({
      model: "deepseek-flash",
      instructions: "",
      input: "",
    });
    await gateway.completeWithTools({
      model: "deepseek-pro",
      messages: [],
      tools: [],
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "run_1",
      stageId: "run_1:s1",
      agentId: "writer",
      source: "model",
      modelId: "deepseek-flash",
      tokensIn: 1000,
      tokensOut: 500,
      unitPriceInMicro: 1000,
      unitPriceOutMicro: 2000,
      priceVersion: "2026-11-01",
      costCnyMicro: 2000,
      tracked: true,
      ts: "2026-11-20T10:00:00.000Z",
    });
    expect(records[1]?.modelId).toBe("deepseek-pro");
    expect(records[0]?.callId).not.toBe(records[1]?.callId);
  });

  it("records a non-run call under its aggregate scope", async () => {
    const records: CostCallRecord[] = [];
    const gateway = new CostTrackingGateway(baseGateway, {
      context: { workspaceId: "default", jobId: "job_1", source: "compose" },
      sink: { record: (record) => records.push(record) },
    });
    await gateway.complete({
      model: "deepseek-flash",
      instructions: "",
      input: "",
    });
    expect(records[0]).toMatchObject({
      runId: "job:job_1",
      scopeKind: "job",
      scopeId: "job_1",
      jobId: "job_1",
      changeId: null,
      managerSessionId: null,
      source: "compose",
    });
  });

  it("records stub completions as untracked, never as spend", async () => {
    const records: CostCallRecord[] = [];
    const gateway = new CostTrackingGateway(new StubModelGateway(), {
      context: { workspaceId: "default", runId: "run_2" },
      sink: { record: (record) => records.push(record) },
    });
    await gateway.complete({
      model: "deepseek-flash",
      instructions: "",
      input: "",
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.tracked).toBe(false);
    expect(records[0]?.costCnyMicro).toBe(0);
    expect(records[0]?.untrackedReason).toContain("stub");
  });

  it("never lets a ledger failure fail the call", async () => {
    const gateway = new CostTrackingGateway(baseGateway, {
      context: { workspaceId: "default", runId: "run_3" },
      sink: {
        record: () => {
          throw new Error("ledger down");
        },
      },
      onError: () => undefined,
    });
    await expect(
      gateway.complete({
        model: "deepseek-flash",
        instructions: "",
        input: "",
      }),
    ).resolves.toMatchObject({ text: "ok" });
  });
});
