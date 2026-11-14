import { PageHeader } from "@/components/kit/page-header";
import { NewPackWizard } from "@/components/packs/new-pack-wizard";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function NewPackPage() {
  const t = await getTranslations("newPack");
  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <NewPackWizard />
    </div>
  );
}
