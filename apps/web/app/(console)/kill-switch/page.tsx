import { KillSwitchConsole } from "@/components/kill-switch/kill-switch-console";
import { loadKillSwitchState } from "@/lib/kill-switch";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function KillSwitchPage() {
  const [state, t] = await Promise.all([
    loadKillSwitchState(),
    getTranslations("killSwitch"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-medium text-zinc-100">{t("title")}</h1>
        <p className="mt-1 text-sm text-zinc-500">{t("subtitle")}</p>
      </div>
      <KillSwitchConsole initial={state} />
    </div>
  );
}
