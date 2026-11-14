"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { PageHeader } from "@/components/kit/page-header";
import { Input } from "@/components/ui/input";
import { useTranslations } from "next-intl";
import { useState } from "react";

export default function ActivityPage() {
  const t = useTranslations("activity");
  const [runId, setRunId] = useState("");
  const [agentId, setAgentId] = useState("");

  return (
    <div className="space-y-6">
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
