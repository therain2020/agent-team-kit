import { PageHeader } from "@/components/kit/page-header";
import { OfficeScene } from "@/components/office/office-scene";
import { loadOfficeChatHistory, loadOfficeData } from "@/lib/office";
import { parseOfficeView } from "@/lib/office-view";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function OfficePage({
  searchParams,
}: {
  searchParams: Promise<{
    pack?: string;
    panel?: string;
    view?: string | string[];
  }>;
}) {
  const { pack, panel, view } = await searchParams;
  const t = await getTranslations("office");
  const data = await loadOfficeData(pack);
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
        initialMessages={initialMessages}
        stubMode={stubMode}
        initialPanel={panel === "manager" ? "chat" : "agent"}
        initialView={parseOfficeView(view)}
      />
    </div>
  );
}
