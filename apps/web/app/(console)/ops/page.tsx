import { PageHeader } from "@/components/kit/page-header";
import { OperationsConsole } from "@/components/ops/operations-console";
import { loadOpsConsole } from "@/lib/ops";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const t = await getTranslations("ops");
  const data = await loadOpsConsole();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <OperationsConsole initial={data} />
    </div>
  );
}
