"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { PageHeader } from "@/components/kit/page-header";
import { Input } from "@/components/ui/input";
import { ArrowLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

export function ActivityView({
  initialRunId,
  fromIteration,
}: {
  initialRunId: string;
  fromIteration: boolean;
}) {
  const t = useTranslations("activity");
  const [runId, setRunId] = useState(initialRunId);
  const [agentId, setAgentId] = useState("");

  useEffect(() => {
    setRunId(initialRunId);
  }, [initialRunId]);

  return (
    <div className="space-y-6">
      {fromIteration && initialRunId ? (
        <Link
          href={`/iterations/${encodeURIComponent(initialRunId)}`}
          className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
        >
          <ArrowLeft className="size-3" />
          {t("backToIteration")}
        </Link>
      ) : null}
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
          placeholder="run id"
          className="h-9 w-64 font-mono text-xs"
        />
        <Input
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          placeholder="agent id"
          className="h-9 w-48 font-mono text-xs"
        />
      </div>
      <ActivityFeed
        runId={runId.trim() || undefined}
        agentId={agentId.trim() || undefined}
        maxHeight="calc(100vh - 18rem)"
      />
    </div>
  );
}
