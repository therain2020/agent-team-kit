import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy run detail URL. Deep links keep their artifact selection and now land
 * in the world drawer (issue #161): `/world?run=<id>&tab=timeline|artifacts`.
 */
export default async function RunRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ artifact?: string }>;
}) {
  const { runId } = await params;
  const { artifact } = await searchParams;
  const id = decodeURIComponent(runId);
  const query = new URLSearchParams({
    run: id,
    tab: artifact ? "artifacts" : "timeline",
  });
  if (artifact) {
    query.set("artifact", artifact);
  }
  redirect(`/world?${query.toString()}`);
}
