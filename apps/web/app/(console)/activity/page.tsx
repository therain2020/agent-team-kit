import { ActivityView } from "./activity-view";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string; from?: string }>;
}) {
  const { runId, from } = await searchParams;
  return (
    <ActivityView
      initialRunId={typeof runId === "string" ? runId.trim() : ""}
      fromIteration={from === "iteration"}
    />
  );
}
