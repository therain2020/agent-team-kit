import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_STALE_MS,
  RunLeaseLostError,
  assertRunLeaseTimings,
  assertWriteLeaseActive,
  currentWriteLeaseLost,
  markWriteLeaseLost,
  withWriteLease,
} from "../src/write-lease";

describe("run lease guard (61 §3.5)", () => {
  it("accepts the default 60s stale / 15s heartbeat timing", () => {
    expect(() =>
      assertRunLeaseTimings(
        DEFAULT_RUN_LEASE_STALE_MS,
        DEFAULT_RUN_LEASE_HEARTBEAT_MS,
      ),
    ).not.toThrow();
  });

  it("rejects a heartbeat that is not at most half the stale window", () => {
    expect(() => assertRunLeaseTimings(60_000, 30_001)).toThrowError(
      /at most half/,
    );
    expect(() => assertRunLeaseTimings(0, 15_000)).toThrowError(/positive/);
  });

  it("blocks further activity once the lease is lost", async () => {
    await withWriteLease(
      { requestId: "rrq_1", owner: "worker-a", leaseVersion: 1 },
      async () => {
        expect(() => assertWriteLeaseActive()).not.toThrow();
        const lost = markWriteLeaseLost(
          new RunLeaseLostError("reclaimed", "rrq_1", 1),
        );
        expect(currentWriteLeaseLost()).toBe(lost);
        expect(() => assertWriteLeaseActive()).toThrowError(RunLeaseLostError);
        expect(() => assertWriteLeaseActive()).toThrowError(/reclaimed/);
      },
    );
  });

  it("clears the lost state when entering a new lease scope", async () => {
    markWriteLeaseLost("stale from previous scope");
    await withWriteLease(
      { requestId: "rrq_2", owner: "worker-b", leaseVersion: 2 },
      async () => {
        expect(currentWriteLeaseLost()).toBeNull();
        expect(() => assertWriteLeaseActive()).not.toThrow();
      },
    );
  });
});
