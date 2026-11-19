/**
 * Route migrations for the consolidated console IA (82 §3, issue #164).
 *
 * Old first-class pages keep working as redirects for one release so shared
 * links and bookmarks never 404. Keep this table the single source of truth:
 * `next.config.ts` feeds it to Next and the web tests assert its contents.
 */
export interface LegacyRedirect {
  source: string;
  destination: string;
  permanent: boolean;
}

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  // Packs + Sources + Workshop collapsed into the three-column /workshop surface.
  { source: "/packs", destination: "/workshop?tab=packs", permanent: false },
  {
    source: "/sources",
    destination: "/workshop?tab=sources",
    permanent: false,
  },
  // Manager chat is an Office side panel now (?panel=manager opens the tab).
  {
    source: "/manager",
    destination: "/office?panel=manager",
    permanent: false,
  },
];
