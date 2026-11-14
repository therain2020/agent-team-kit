"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export function RunPicker({
  runs,
  value,
}: {
  runs: Array<{ runId: string; status: string }>;
  value: string;
}) {
  const router = useRouter();
  const statusT = useTranslations("status");

  return (
    <select
      value={value}
      onChange={(event) => {
        router.push(`/manager?runId=${encodeURIComponent(event.target.value)}`);
      }}
      className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-300 outline-none focus:border-ring"
    >
      {runs.map((run) => (
        <option key={run.runId} value={run.runId}>
          {run.runId} · {statusT(run.status)}
        </option>
      ))}
    </select>
  );
}
