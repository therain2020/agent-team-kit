import { Badge } from "@/components/ui/badge";
import { getTranslations } from "next-intl/server";
import { CommandPalette } from "./command-palette";
import { HealthPill } from "./health-pill";
import { LocaleSwitcher } from "./locale-switcher";

export async function Topbar() {
  const t = await getTranslations("topbar");

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/80 px-5 backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("console")}</span>
        <span className="text-zinc-700">/</span>
        <Badge variant="outline">{t("local")}</Badge>
        <Badge variant="default">{t("dryRunDefault")}</Badge>
      </div>
      <div className="flex items-center gap-3">
        <LocaleSwitcher />
        <CommandPalette />
        <HealthPill />
      </div>
    </header>
  );
}
