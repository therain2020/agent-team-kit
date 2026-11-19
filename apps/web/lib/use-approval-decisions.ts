"use client";

import { useCallback, useState } from "react";

/**
 * One decision path for both approvals views (82 §4.3, #146 CAS semantics).
 *
 * The queue view approves a single card, the factory view approves the
 * highlighted workpiece, and either can batch. All three call into this hook
 * so the request bodies, the per-item CAS outcomes and the "settled" set that
 * hides optimistic rows cannot drift apart between views.
 */

export type DecisionKind = "approve" | "reject";

export interface DecisionTarget {
  runId: string;
  requestId: string;
  /** Approvals entity version; batch sends it, single decisions do not. */
  version?: number | null;
}

export interface DecisionOutcome {
  ok: boolean;
  error?: string;
  /** Request ids the server accepted; views hide these immediately. */
  settled: string[];
}

export interface BatchOutcome {
  runId: string;
  requestId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface BatchSummary {
  requested: number;
  succeeded: number;
  failed: number;
  results: BatchOutcome[];
}

type BatchResponse = {
  error?: string;
  requested?: number;
  succeeded?: number;
  failed?: number;
  results?: BatchOutcome[];
};

export interface ApprovalDecisions {
  pending: boolean;
  /** Last batch, kept until the operator dismisses it (partial failures stay). */
  batchResult: BatchSummary | null;
  /** Request ids whose decision succeeded in this session. */
  settled: ReadonlySet<string>;
  decide: (
    target: DecisionTarget,
    kind: DecisionKind,
    note: string,
  ) => Promise<DecisionOutcome>;
  batch: (
    kind: DecisionKind,
    targets: readonly DecisionTarget[],
    note: string,
  ) => Promise<DecisionOutcome & { summary: BatchSummary | null }>;
  takeOver: (target: DecisionTarget) => Promise<DecisionOutcome>;
  clearBatchResult: () => void;
}

interface Options {
  /** Message shown when the server returns no usable error body. */
  fallbackError: string;
  /** Message for `requestId`-less or otherwise malformed targets. */
  invalidError: string;
}

export function useApprovalDecisions({
  fallbackError,
  invalidError,
}: Options): ApprovalDecisions {
  const [pending, setPending] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchSummary | null>(null);
  const [settled, setSettled] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const settle = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) {
      return;
    }
    setSettled((current) => {
      const next = new Set(current);
      for (const id of ids) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const decide = useCallback(
    async (
      target: DecisionTarget,
      kind: DecisionKind,
      note: string,
    ): Promise<DecisionOutcome> => {
      if (!target.requestId || !target.runId) {
        return { ok: false, error: invalidError, settled: [] };
      }
      setPending(true);
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(target.runId)}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decision: kind === "approve" ? "approve" : "abort",
              note,
              requestId: target.requestId,
            }),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          return {
            ok: false,
            error: payload.error ?? fallbackError,
            settled: [],
          };
        }
        settle([target.requestId]);
        return { ok: true, settled: [target.requestId] };
      } catch (problem) {
        return {
          ok: false,
          error: problem instanceof Error ? problem.message : fallbackError,
          settled: [],
        };
      } finally {
        setPending(false);
      }
    },
    [fallbackError, invalidError, settle],
  );

  const batch = useCallback(
    async (
      kind: DecisionKind,
      targets: readonly DecisionTarget[],
      note: string,
    ): Promise<DecisionOutcome & { summary: BatchSummary | null }> => {
      if (targets.length === 0) {
        return { ok: false, error: invalidError, settled: [], summary: null };
      }
      setPending(true);
      try {
        const response = await fetch("/api/approvals/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: kind,
            note,
            items: targets.map((target) => ({
              runId: target.runId,
              requestId: target.requestId,
              version: target.version ?? null,
            })),
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as
          | BatchResponse
          | { error?: string };
        if (!response.ok || !("results" in payload)) {
          const message =
            "error" in payload && payload.error ? payload.error : fallbackError;
          return { ok: false, error: message, settled: [], summary: null };
        }

        const results = (payload.results ?? []).map((result) => ({
          runId: result.runId,
          requestId: result.requestId,
          ok: result.ok,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.error ? { error: result.error } : {}),
        }));
        const okIds = results
          .filter((result) => result.ok)
          .map((result) => result.requestId);
        const summary: BatchSummary = {
          requested: payload.requested ?? results.length,
          succeeded: payload.succeeded ?? okIds.length,
          failed: payload.failed ?? results.length - okIds.length,
          results,
        };
        setBatchResult(summary);
        settle(okIds);
        return { ok: summary.failed === 0, settled: okIds, summary };
      } catch (problem) {
        return {
          ok: false,
          error: problem instanceof Error ? problem.message : fallbackError,
          settled: [],
          summary: null,
        };
      } finally {
        setPending(false);
      }
    },
    [fallbackError, invalidError, settle],
  );

  const takeOver = useCallback(
    async (target: DecisionTarget): Promise<DecisionOutcome> => {
      if (!target.requestId) {
        return { ok: false, error: invalidError, settled: [] };
      }
      setPending(true);
      try {
        const response = await fetch(
          `/api/approvals/${encodeURIComponent(target.requestId)}/assign`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: target.version ?? null }),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          return {
            ok: false,
            error: payload.error ?? fallbackError,
            settled: [],
          };
        }
        return { ok: true, settled: [] };
      } catch (problem) {
        return {
          ok: false,
          error: problem instanceof Error ? problem.message : fallbackError,
          settled: [],
        };
      } finally {
        setPending(false);
      }
    },
    [fallbackError, invalidError],
  );

  const clearBatchResult = useCallback(() => setBatchResult(null), []);

  return {
    pending,
    batchResult,
    settled,
    decide,
    batch,
    takeOver,
    clearBatchResult,
  };
}
