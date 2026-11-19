import {
  FlaskConical,
  Gamepad2,
  Globe2,
  Inbox,
  type LucideIcon,
  Package,
  Siren,
} from "lucide-react";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  /** Show the paused-approval badge. Only Approvals sets this. */
  badge?: boolean;
  /** `g`-prefixed quick-jump key: press `g` then this letter (issue #160). */
  shortcut: string;
}

/**
 * The six first-class console entries (82 §3, issue #160). Everything else is
 * a drill-down or a legacy route folded into one of these surfaces.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/office", labelKey: "office", icon: Gamepad2, shortcut: "o" },
  { href: "/world", labelKey: "world", icon: Globe2, shortcut: "w" },
  {
    href: "/approvals",
    labelKey: "approvals",
    icon: Inbox,
    badge: true,
    shortcut: "a",
  },
  { href: "/workshop", labelKey: "workshop", icon: Package, shortcut: "s" },
  {
    href: "/evolution",
    labelKey: "evolution",
    icon: FlaskConical,
    shortcut: "e",
  },
  { href: "/ops", labelKey: "ops", icon: Siren, shortcut: "p" },
];

/** `g`-prefix quick-jump key → destination, derived from NAV_ITEMS. */
export const QUICK_JUMP: ReadonlyMap<string, string> = new Map(
  NAV_ITEMS.map((item) => [item.shortcut, item.href]),
);

/** Human-readable chord for a nav item, e.g. `g o`. */
export function shortcutLabel(item: NavItem): string {
  return `g ${item.shortcut}`;
}

/** Resolve a quick-jump letter to its href, or null when unbound. */
export function quickJumpHref(key: string): string | null {
  return QUICK_JUMP.get(key.toLowerCase()) ?? null;
}

export function matchNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
