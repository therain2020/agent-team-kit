import { describe, expect, it } from "vitest";
import { JAEGER_UI_ENV, TEMPORAL_UI_ENV, traceTargets } from "../lib/traces";

const runId = "run_01ABC";
const tags = encodeURIComponent(JSON.stringify({ "run.id": runId }));

describe("traceTargets (#80)", () => {
  it("keeps the three run-scoped targets in a stable order", () => {
    const targets = traceTargets(runId, {});
    expect(targets.map((target) => target.id)).toEqual([
      "jaegerWorker",
      "jaegerCli",
      "temporal",
    ]);
  });

  it("builds Jaeger and Temporal deep links filtered by run.id", () => {
    const targets = traceTargets(runId, {
      jaegerUiUrl: "https://jaeger.example.com",
      temporalUiUrl: "https://temporal.example.com",
    });

    expect(targets[0]?.href).toBe(
      `https://jaeger.example.com/search?service=kit-worker&tags=${tags}`,
    );
    expect(targets[1]?.href).toBe(
      `https://jaeger.example.com/search?service=kit-cli&tags=${tags}`,
    );
    expect(targets[2]?.href).toBe(
      `https://temporal.example.com/namespaces/default/workflows/pack-${encodeURIComponent(runId)}`,
    );
  });

  it("normalizes trailing slashes and surrounding whitespace", () => {
    const targets = traceTargets(runId, {
      jaegerUiUrl: "  https://jaeger.example.com//  ",
      temporalUiUrl: "https://temporal.example.com/",
    });

    expect(targets[0]?.href).toBe(
      `https://jaeger.example.com/search?service=kit-worker&tags=${tags}`,
    );
    expect(targets[2]?.href).toBe(
      `https://temporal.example.com/namespaces/default/workflows/pack-${encodeURIComponent(runId)}`,
    );
  });

  it("never falls back to localhost and reports the env var to configure", () => {
    for (const targets of [
      traceTargets(runId, {}),
      traceTargets(runId, { jaegerUiUrl: "   ", temporalUiUrl: "" }),
    ]) {
      expect(targets.map((target) => target.href)).toEqual([null, null, null]);
      expect(targets.map((target) => target.envVar)).toEqual([
        JAEGER_UI_ENV,
        JAEGER_UI_ENV,
        TEMPORAL_UI_ENV,
      ]);
    }
  });

  it("disables only the target whose backend is missing", () => {
    const targets = traceTargets(runId, {
      jaegerUiUrl: "https://jaeger.example.com",
    });
    expect(targets[0]?.href).not.toBeNull();
    expect(targets[1]?.href).not.toBeNull();
    expect(targets[2]?.href).toBeNull();
  });
});
