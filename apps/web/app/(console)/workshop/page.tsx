import { WorkshopSurface } from "@/components/workshop/workshop-surface";
import { loadInstalledWorkshop } from "@/lib/workshop";
import { parseWorkshopTab, pickSelectedPack } from "@/lib/workshop-link";
import { loadWorkshopSurface } from "@/lib/workshop-surface";

export const dynamic = "force-dynamic";

export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; pack?: string; new?: string }>;
}) {
  const { tab, pack, new: openNew } = await searchParams;
  const [data, workshopInstalled] = await Promise.all([
    loadWorkshopSurface(),
    loadInstalledWorkshop(),
  ]);
  const selected = pickSelectedPack(data.packs, pack);

  return (
    <WorkshopSurface
      data={data}
      initialTab={parseWorkshopTab(tab)}
      initialPack={selected?.dirName}
      initialNewOpen={openNew === "1"}
      workshopInstalled={workshopInstalled}
    />
  );
}
