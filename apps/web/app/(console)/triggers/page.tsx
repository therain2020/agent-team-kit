import { TriggersConsole } from "@/components/jobs/triggers-console";
import { type TriggerConsoleData, loadTriggerConsole } from "@/lib/triggers";

export const dynamic = "force-dynamic";

/**
 * `/triggers` — the control surface migrated from `/autopilot` (96 §5.5, T5).
 * It lists every mapped trigger, its daily budget, next fire and daemon health;
 * "fire now" dispatches exactly one trigger through the existing manual adapter.
 */
export default async function TriggersPage() {
  let data: TriggerConsoleData | null = null;
  let error: string | null = null;
  try {
    data = await loadTriggerConsole();
  } catch (loadError) {
    error =
      loadError instanceof Error
        ? loadError.message
        : "failed to load triggers";
  }

  return <TriggersConsole initial={data} error={error} />;
}
