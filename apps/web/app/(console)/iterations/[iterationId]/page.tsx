import { IterationDetailView } from "./detail-view";

export default async function IterationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ iterationId: string }>;
  searchParams: Promise<{ task?: string }>;
}) {
  const { iterationId } = await params;
  const { task } = await searchParams;
  return (
    <IterationDetailView
      iterationId={iterationId}
      initialTask={typeof task === "string" ? task : null}
    />
  );
}
