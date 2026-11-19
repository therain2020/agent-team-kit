import { jobErrorResponse } from "@/lib/job-api";
import { loadJobHubSummary } from "@/lib/job-hub";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { loadWorldDrawerData } from "@/lib/world-page";
import { type JobKind, getJob } from "@kit/job";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/jobs/<id>` — the job detail hub (#107).
 *
 * Returns the job summary plus the cross-plane aggregate: approvals, pending
 * apply tickets, report, related artifacts, evolution cycles and the deep
 * links into each owning surface. Contents are never inlined; every entry is
 * an id (and version) that resolves on its own page.
 *
 * Backward compatible: `job` stays at the top level for existing callers.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId: raw } = await params;
  const jobId = decodeURIComponent(raw);
  const url = new URL(request.url);
  const kind = parseKind(url.searchParams.get("kind"));

  try {
    await ensureStoreSchema();
    const store = getStore();

    if (kind) {
      const job = await getJob(store, kind, jobId);
      if (!job) {
        return NextResponse.json({ error: "job not found" }, { status: 404 });
      }
    }

    // The drawer loader owns kind resolution: it probes iteration_runs first,
    // then runs, exactly like `/world?run=`.
    const drawer = await loadWorldDrawerData(jobId);
    if (drawer.kind === "missing") {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    if (kind && !matchesKind(kind, drawer.kind)) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }

    const hub = await loadJobHubSummary(drawer);
    return NextResponse.json({ job: hub?.job ?? null, hub });
  } catch (error) {
    return jobErrorResponse(error);
  }
}

function parseKind(value: string | null): JobKind | undefined {
  return value === "iteration" || value === "packRun" ? value : undefined;
}

function matchesKind(kind: JobKind, drawerKind: "run" | "iteration"): boolean {
  return kind === "iteration"
    ? drawerKind === "iteration"
    : drawerKind === "run";
}
