import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Activity moved into the world drawer (issue #161). */
export default async function ActivityRedirect({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string; from?: string }>;
}) {
  const { runId } = await searchParams;
  const id = typeof runId === "string" ? runId.trim() : "";
  if (id) {
    redirect(`/world?run=${encodeURIComponent(id)}&tab=activity`);
  }
  redirect("/world?tab=activity");
}
