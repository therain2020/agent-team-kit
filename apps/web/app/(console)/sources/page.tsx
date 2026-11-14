import { PageHeader } from "@/components/kit/page-header";
import { SourcesMarket } from "@/components/sources/sources-market";
import { loadInstalledSources } from "@/lib/sources";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  const t = await getTranslations("sources");
  const installed = await loadInstalledSources();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <SourcesMarket
        installed={installed.map((source) => ({
          name: source.definition.metadata.name,
          version: source.definition.metadata.version,
          description: source.definition.metadata.description ?? "",
          homepage: source.definition.metadata.homepage,
          license: source.definition.metadata.license,
          repo: source.meta.repo,
          commit: source.meta.commit,
          trust: source.meta.trust,
        }))}
      />
    </div>
  );
}
