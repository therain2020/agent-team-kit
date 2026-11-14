import { FactoryFloor } from "@/components/factory/factory-floor";
import { loadFactorySnapshot } from "@/lib/factory-server";

export const dynamic = "force-dynamic";

export default async function FactoryPage() {
  const snapshot = await loadFactorySnapshot();
  return (
    <FactoryFloor
      initialItems={snapshot.items}
      initialStations={snapshot.stations}
    />
  );
}
