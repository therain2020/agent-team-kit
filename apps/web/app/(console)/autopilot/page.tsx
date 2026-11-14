import { AutopilotConsole } from "@/components/autopilot/autopilot-console";
import { PageHeader } from "@/components/kit/page-header";
import { loadAutopilotOverview } from "@/lib/autopilot";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function AutopilotPage() {
  const t = await getTranslations("autopilot");
  const overview = await loadAutopilotOverview();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <AutopilotConsole overview={overview} />
    </div>
  );
}
