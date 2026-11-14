import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { PackStudio } from "@/components/studio/pack-studio";
import { loadStudioData } from "@/lib/pack-studio";
import { Package, Settings2 } from "lucide-react";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function PackStudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ dirName: string }>;
  searchParams: Promise<{ agent?: string }>;
}) {
  const { dirName } = await params;
  const { agent } = await searchParams;
  const data = await loadStudioData(decodeURIComponent(dirName));
  const t = await getTranslations("studio");
  const common = await getTranslations("common");

  if (!data) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("title")} />
        <EmptyState
          icon={Package}
          title={t("invalidTitle")}
          description={t("invalidDesc")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${data.packName} · ${t("title")}`}
        description={data.description || t("description")}
        actions={
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
            <Settings2 className="size-3" />
            packs/{data.dirName}
          </span>
        }
      />
      <PackStudio data={data} initialAgentId={agent} />
      <p className="text-[10px] text-zinc-600">
        {common("details")} · {t("footer")}
      </p>
    </div>
  );
}
