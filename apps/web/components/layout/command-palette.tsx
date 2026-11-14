"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Command } from "cmdk";
import {
  Activity,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  MessageSquare,
  Package,
  Play,
  Search,
  Siren,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const ITEMS = [
  { href: "/", labelKey: "commandCenter", icon: LayoutDashboard },
  { href: "/manager", labelKey: "manager", icon: MessageSquare },
  { href: "/inbox", labelKey: "inbox", icon: Inbox },
  { href: "/ops", labelKey: "ops", icon: Siren },
  { href: "/runs", labelKey: "runs", icon: Play },
  { href: "/packs", labelKey: "packs", icon: Package },
  { href: "/evolution", labelKey: "evolution", icon: FlaskConical },
  { href: "/traces", labelKey: "traces", icon: Activity },
];

export function CommandPalette() {
  const router = useRouter();
  const t = useTranslations("commandPalette");
  const nav = useTranslations("nav");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-md border border-border px-2 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-300 sm:flex"
      >
        <Search className="size-3" />
        {t("jumpTo").replace("…", "")}
        <kbd className="rounded border border-border bg-zinc-900 px-1 font-mono text-[10px] text-zinc-500">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[22%] max-w-lg translate-y-0 p-0">
          <DialogTitle className="sr-only">{t("paletteTitle")}</DialogTitle>
          <Command
            loop
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600"
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-zinc-500" />
              <Command.Input
                autoFocus
                placeholder={t("jumpTo")}
                className="h-11 w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center text-xs text-zinc-500">
                {t("noMatches")}
              </Command.Empty>
              <Command.Group heading={t("navigate")}>
                {ITEMS.map((item) => {
                  const Icon = item.icon;
                  const label = nav(item.labelKey);
                  return (
                    <Command.Item
                      key={item.href}
                      value={label}
                      onSelect={() => go(item.href)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs text-zinc-400 data-[selected=true]:bg-accent data-[selected=true]:text-zinc-100",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </Command.Item>
                  );
                })}
              </Command.Group>
              <Command.Group heading={t("actions")}>
                <Command.Item
                  value={t("startRun")}
                  onSelect={() => go("/packs")}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs text-zinc-400 data-[selected=true]:bg-accent data-[selected=true]:text-zinc-100"
                >
                  <Play className="size-3.5" />
                  {t("startRun")}
                </Command.Item>
                <Command.Item
                  value={t("reviewApprovals")}
                  onSelect={() => go("/inbox")}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs text-zinc-400 data-[selected=true]:bg-accent data-[selected=true]:text-zinc-100"
                >
                  <Inbox className="size-3.5" />
                  {t("reviewApprovals")}
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
