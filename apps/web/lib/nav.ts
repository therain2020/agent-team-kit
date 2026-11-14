import {
  Activity,
  Factory,
  FlaskConical,
  Gamepad2,
  GitBranch,
  Globe2,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Package,
  Play,
  Power,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Siren,
  Store,
  Wallet,
} from "lucide-react";

export interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/office", labelKey: "office", icon: Gamepad2 },
  { href: "/", labelKey: "commandCenter", icon: LayoutDashboard, exact: true },
  { href: "/manager", labelKey: "manager", icon: MessageSquare },
  { href: "/factory", labelKey: "factory", icon: Factory, badge: true },
  { href: "/inbox", labelKey: "inbox", icon: Inbox, badge: true },
  { href: "/ops", labelKey: "ops", icon: Siren },
  { href: "/runs", labelKey: "runs", icon: Play },
  { href: "/iterations", labelKey: "iterations", icon: GitBranch },
  { href: "/activity", labelKey: "activity", icon: ScrollText },
  { href: "/packs", labelKey: "packs", icon: Package },
  { href: "/sources", labelKey: "sources", icon: Globe2 },
  { href: "/workshop", labelKey: "workshop", icon: Store },
  { href: "/autopilot", labelKey: "autopilot", icon: ShieldCheck },
  { href: "/degradation", labelKey: "degradation", icon: ShieldAlert },
  { href: "/budgets", labelKey: "budgets", icon: Wallet },
  { href: "/evolution", labelKey: "evolution", icon: FlaskConical },
  { href: "/traces", labelKey: "traces", icon: Activity },
  { href: "/kill-switch", labelKey: "killSwitch", icon: Power },
];

export function matchNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) =>
    item.exact
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
