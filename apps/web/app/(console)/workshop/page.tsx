import { PageHeader } from "@/components/kit/page-header";
import { WorkshopMarket } from "@/components/workshop/workshop-market";
import { loadInstalledWorkshop } from "@/lib/workshop";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function WorkshopPage() {
  const t = await getTranslations("workshop");
  const installed = await loadInstalledWorkshop();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <WorkshopMarket installed={installed} />
    </div>
  );
}
