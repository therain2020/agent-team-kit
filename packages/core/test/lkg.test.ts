import { describe, expect, it } from "vitest";
import {
  LkgContractError,
  assertExternallyVerified,
  enterDegradedMode,
  isLkgFresh,
  lkgVerification,
  registerLastKnownGood,
  resolveExternalDelivery,
  selectLastKnownGood,
  switchLastKnownGood,
} from "../src/index";

const at = "2026-11-15T00:00:00.000Z";
const exactlySevenDays = "2026-11-22T00:00:00.000Z";
const pastSevenDays = "2026-11-22T00:00:00.001Z";

function lkg(overrides: Record<string, unknown> = {}) {
  return registerLastKnownGood({
    workspaceId: "ws-1",
    artifactRefs: [{ artifactId: "art_1", version: 1 }],
    verifier: "alice",
    now: at,
    ...overrides,
  });
}

function degradedMode(overrides: Record<string, unknown> = {}) {
  return enterDegradedMode({
    scope: "workspace",
    workspaceId: "ws-1",
    kind: "degraded",
    triggers: [{ dependencyId: "model.provider", reason: "provider down" }],
    behavior: "serve the last-known-good",
    actor: "tester",
    now: at,
    ...overrides,
  });
}

describe("artifact last-known-good", () => {
  it("requires a verifier and at least one artifact ref", () => {
    expect(() => lkg({ verifier: "" })).toThrow();
    expect(() => lkg({ artifactRefs: [] })).toThrow();
  });

  it("stays verified for exactly 7 days and degrades one millisecond after", () => {
    const record = lkg();
    expect(isLkgFresh(record, exactlySevenDays)).toBe(true);
    expect(lkgVerification(record, exactlySevenDays).state).toBe("verified");
    expect(lkgVerification(record, pastSevenDays).state).toBe("stale");
    expect(lkgVerification(record, pastSevenDays).expiresAt).toBe(
      exactlySevenDays,
    );
  });

  it("blocks external use of a stale or missing pin", () => {
    expect(() => assertExternallyVerified(lkg(), pastSevenDays)).toThrow(
      LkgContractError,
    );
    try {
      assertExternallyVerified(null);
    } catch (error) {
      expect((error as LkgContractError).code).toBe("lkg_missing");
    }
    expect(assertExternallyVerified(lkg(), exactlySevenDays).state).toBe(
      "verified",
    );
  });

  it("supersedes the previous pin and links the chain", () => {
    const first = lkg();
    const second = lkg({ lkgId: "lkg_2", verifier: "bob" });
    const transition = switchLastKnownGood({
      previous: [first],
      next: second,
    });

    expect(transition.previous).toHaveLength(1);
    expect(transition.previous[0]).toMatchObject({
      lkgId: first.lkgId,
      status: "superseded",
      supersededBy: "lkg_2",
    });
    expect(transition.next).toMatchObject({
      lkgId: "lkg_2",
      status: "active",
      supersedes: first.lkgId,
    });
  });

  it("prefers the pin that contains the requested artifact", () => {
    const older = lkg({ lkgId: "lkg_old", now: at });
    const newer = lkg({
      lkgId: "lkg_new",
      artifactRefs: [{ artifactId: "art_2", version: 1 }],
      now: "2026-11-16T00:00:00.000Z",
    });

    expect(selectLastKnownGood([older, newer])?.lkgId).toBe("lkg_new");
    expect(selectLastKnownGood([older, newer], "art_1")?.lkgId).toBe("lkg_old");
    expect(selectLastKnownGood([], "art_1")).toBeNull();
  });

  it("serves external delivery from the LKG while degraded", () => {
    const decision = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "im",
      mode: degradedMode(),
      lkg: lkg(),
      now: exactlySevenDays,
    });

    expect(decision.ok).toBe(true);
    expect(decision.external).toBe(true);
    expect(decision.source).toBe("lkg");
    expect(decision.artifactId).toBe("art_1");
    expect(decision.verifiedAt).toBe(at);
    expect(decision.verifier).toBe("alice");
  });

  it("keeps stale LKG content internal-only during degradation", () => {
    const decision = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "webhook",
      mode: degradedMode(),
      lkg: lkg(),
      now: pastSevenDays,
    });

    expect(decision.ok).toBe(false);
    expect(decision.source).toBe("artifact");
    expect(decision.reasons[0]).toContain("internal-only");
  });

  it("blocks external delivery when no LKG is registered", () => {
    const decision = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "email",
      mode: degradedMode(),
      lkg: null,
      now: at,
    });

    expect(decision.ok).toBe(false);
    expect(decision.reasons[0]).toContain("last-known-good");
  });

  it("leaves internal channels and healthy workspaces on the current artifact", () => {
    const internal = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "local_file",
      mode: degradedMode(),
      lkg: null,
      now: at,
    });
    expect(internal).toMatchObject({
      ok: true,
      external: false,
      source: "artifact",
      artifactId: "art_new",
    });

    const healthy = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "im",
      mode: null,
      lkg: null,
      now: at,
    });
    expect(healthy).toMatchObject({ ok: true, source: "artifact" });
  });

  it("keeps read-only mode closed for every channel", () => {
    const decision = resolveExternalDelivery({
      artifactId: "art_new",
      channel: "im",
      mode: degradedMode({ kind: "read_only" }),
      lkg: lkg(),
      now: at,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("read-only mode blocks delivery");
  });
});
