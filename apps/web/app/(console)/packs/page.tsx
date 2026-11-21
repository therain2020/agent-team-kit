import { PackLibraryView } from "@/components/workshop/pack-library-view";
import { loadInstalledWorkshop } from "@/lib/workshop";
import { pickSelectedPack } from "@/lib/workshop-link";
import { loadWorkshopSurface } from "@/lib/workshop-surface";

export const dynamic = "force-dynamic";

/**
 * Local pack library (88 §3.4 M2, D-69). Packs installed from the workshop are
 * loaded straight from `packs/` and keep their `.workshop.json` origin; the
 * discovery center is one link away.
 */
export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<{ pack?: string; new?: string }>;
}) {
  const { pack, new: openNew } = await searchParams;
  const [data, workshopInstalled] = await Promise.all([
    loadWorkshopSurface(),
    loadInstalledWorkshop(),
  ]);
  const selected = pickSelectedPack(data.packs, pack);
  const packDirs = new Set(data.packs.map((entry) => entry.dirName));
  // Packs still only in workshop/ (installed before packs landed in packs/).
  const legacyPacks = workshopInstalled.filter(
    (record) =>
      record.kind === "pack" &&
      !packDirs.has(record.id) &&
      !packDirs.has(record.dirName),
  );

  return (
    <PackLibraryView
      packs={data.packs}
      initialPack={selected?.dirName}
      initialNewOpen={openNew === "1"}
      legacyPacks={legacyPacks}
    />
  );
}
