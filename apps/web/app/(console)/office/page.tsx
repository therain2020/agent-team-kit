import { PageHeader } from "@/components/kit/page-header";
import { OfficeScene } from "@/components/office/office-scene";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { loadFactoryLink } from "@/lib/factory-server";
import {
  findPackForAgent,
  loadOfficeChatHistory,
  loadOfficeData,
} from "@/lib/office";
import {
  officeLinkProblem,
  parseOfficeRoomParams,
} from "@/lib/office-deeplink";
import { parseOfficeView } from "@/lib/office-view";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function OfficePage({
  searchParams,
}: {
  searchParams: Promise<{
    pack?: string;
    panel?: string;
    view?: string | string[];
    agent?: string;
  }>;
}) {
  const params = await searchParams;
  const { pack, agent } = parseOfficeRoomParams(params);
  const t = await getTranslations("office");
  // A factory deep link knows the producer but not its pack; resolve the pack
  // first so the station it selects is the same one the office renders.
  const resolvedPack = pack ?? (agent ? await findPackForAgent(agent) : null);
  const [data, factoryLink] = await Promise.all([
    loadOfficeData(resolvedPack ?? undefined),
    loadFactoryLink().catch(() => null),
  ]);
  const problem = officeLinkProblem({ pack, agent }, data);

  if (problem) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} description={t("description")} />
        <OfficeLinkEmpty
          hint={
            problem === "pack"
              ? t("linkEmptyPack", { pack: pack ?? "—" })
              : t("linkEmptyAgent", { agent: agent ?? "—" })
          }
          title={t("linkEmptyTitle")}
          clearLabel={t("linkClear")}
        />
      </div>
    );
  }

  const initialMessages = data.active
    ? (await loadOfficeChatHistory(data.active.dirName)).messages
    : [];
  const stubMode =
    process.env.KIT_MODEL_MODE === "stub" || !process.env.DEEPSEEK_API_KEY;

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      <OfficeScene
        key={data.active?.dirName ?? "empty"}
        data={data}
        factoryLink={factoryLink}
        initialAgentId={agent}
        initialMessages={initialMessages}
        stubMode={stubMode}
        initialPanel={params.panel === "manager" ? "chat" : "agent"}
        initialView={parseOfficeView(params.view)}
      />
    </div>
  );
}

/**
 * Deep links are validated, never coerced (97 §3.5): an unknown pack or agent
 * lands on an explicit empty state instead of another pack's floor.
 */
function OfficeLinkEmpty({
  title,
  hint,
  clearLabel,
}: {
  title: string;
  hint: string;
  clearLabel: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-8 text-center">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="text-xs text-zinc-500">{hint}</p>
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href="/office">{clearLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
