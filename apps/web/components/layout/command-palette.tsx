"use client";

import { setLocale } from "@/app/actions/locale";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { Locale } from "@/i18n/config";
import { NAV_ITEMS, type NavItem, matchNavItem } from "@/lib/nav";
import { Command } from "cmdk";
import {
  GitBranch,
  Inbox,
  Languages,
  type LucideIcon,
  Play,
  Power,
  Search,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const RECENT_KEY = "kit.command-palette.recent";
const RECENT_LIMIT = 5;

const itemClass =
  "flex cursor-pointer items-center gap-2 rounded-none px-2 py-2 font-mono text-[11px] text-px-muted data-[selected=true]:bg-px-panel3 data-[selected=true]:text-px-strong data-[selected=true]:shadow-[inset_2px_0_0_var(--px-accent)]";

function PaletteItem({
  value,
  icon: Icon,
  label,
  onSelect,
}: {
  value: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={itemClass}>
      <Icon className="size-3.5" />
      {label}
    </Command.Item>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations("commandPalette");
  const nav = useTranslations("nav");
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENT_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        setRecent(
          parsed
            .filter(
              (href): href is string =>
                typeof href === "string" &&
                NAV_ITEMS.some((item) => item.href === href),
            )
            .slice(0, RECENT_LIMIT),
        );
      }
    } catch {
      // A corrupt or unavailable store just means no recents.
    }
  }, []);

  useEffect(() => {
    const current = matchNavItem(pathname);
    if (!current) {
      return;
    }
    setRecent((previous) => {
      const next = [
        current.href,
        ...previous.filter((href) => href !== current.href),
      ].slice(0, RECENT_LIMIT);
      try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }, [pathname]);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  function switchLanguage() {
    setOpen(false);
    startTransition(async () => {
      await setLocale(locale === "zh" ? "en" : "zh");
      router.refresh();
    });
  }

  const recentItems = recent
    .map((href) => NAV_ITEMS.find((item) => item.href === href))
    .filter((item): item is NavItem => Boolean(item));

  const actions = [
    {
      id: "newIteration",
      label: t("newIteration"),
      icon: GitBranch,
      perform: () => go("/iterations?new=1"),
    },
    {
      id: "startRun",
      label: t("startRun"),
      icon: Play,
      perform: () => go("/packs"),
    },
    {
      id: "reviewApprovals",
      label: t("reviewApprovals"),
      icon: Inbox,
      perform: () => go("/inbox"),
    },
    {
      id: "openKillSwitch",
      label: t("openKillSwitch"),
      icon: Power,
      perform: () => go("/kill-switch"),
    },
    {
      id: "switchLanguage",
      label: t("switchLanguage"),
      icon: Languages,
      perform: switchLanguage,
    },
  ];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-none border border-px-line2 bg-px-ink px-2 py-1 font-mono text-[10px] tracking-[0.1em] text-px-muted uppercase transition-colors hover:border-zinc-600 hover:bg-px-panel3 hover:text-px-text sm:flex"
      >
        <Search className="size-3" />
        {t("jumpTo").replace("…", "")}
        <kbd className="border border-px-line2 bg-px-panel2 px-1 font-mono text-[10px] text-px-muted">
          ⌘K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[22%] max-w-lg translate-y-0 p-0">
          <DialogTitle className="sr-only">{t("paletteTitle")}</DialogTitle>
          <Command
            loop
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-px-muted"
          >
            <div className="flex items-center gap-2 border-b border-px-line px-3">
              <Search className="size-4 text-px-muted" />
              <Command.Input
                autoFocus
                placeholder={t("jumpTo")}
                className="h-11 w-full bg-transparent font-mono text-[13px] text-px-text outline-none placeholder:text-px-faint"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center font-mono text-[11px] text-px-muted">
                {t("noMatches")}
              </Command.Empty>
              {recentItems.length > 0 ? (
                <Command.Group heading={t("recent")}>
                  {recentItems.map((item) => {
                    const label = nav(item.labelKey);
                    return (
                      <PaletteItem
                        key={`recent-${item.href}`}
                        value={label}
                        icon={item.icon}
                        label={label}
                        onSelect={() => go(item.href)}
                      />
                    );
                  })}
                </Command.Group>
              ) : null}
              <Command.Group heading={t("navigate")}>
                {NAV_ITEMS.map((item) => {
                  const label = nav(item.labelKey);
                  return (
                    <PaletteItem
                      key={item.href}
                      value={label}
                      icon={item.icon}
                      label={label}
                      onSelect={() => go(item.href)}
                    />
                  );
                })}
              </Command.Group>
              <Command.Group heading={t("actions")}>
                {actions.map((action) => (
                  <PaletteItem
                    key={action.id}
                    value={action.label}
                    icon={action.icon}
                    label={action.label}
                    onSelect={action.perform}
                  />
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
