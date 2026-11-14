import { BudgetConsole } from "@/components/budgets/budget-console";
import { PageHeader } from "@/components/kit/page-header";
import { loadBudgetOverview } from "@/lib/budgets";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const t = await getTranslations("budgets");
  const overview = await loadBudgetOverview();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <BudgetConsole overview={overview} />
    </div>
  );
}
