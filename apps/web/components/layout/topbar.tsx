import { Badge } from "@/components/ui/badge";
import { getTranslations } from "next-intl/server";
import { CommandPalette } from "./command-palette";
import { HealthPill } from "./health-pill";
import { LocaleSwitcher } from "./locale-switcher";
import { QuickJump } from "./quick-jump";

export async function Topbar() {
  const t = await getTranslations("topbar");

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-px-line bg-px-panel px-5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.14em] text-px-muted uppercase">
          {t("console")}
        </span>
        <span className="font-mono text-[10px] text-px-line2">/</span>
        <Badge variant="outline">{t("local")}</Badge>
        <Badge variant="default">{t("dryRunDefault")}</Badge>
      </div>
      <div className="flex items-center gap-3">
        <QuickJump />
        <LocaleSwitcher />
        <CommandPalette />
        <HealthPill />
      </div>
    </header>
  );
}
