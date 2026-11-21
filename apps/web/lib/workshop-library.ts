/**
 * Client-safe workshop asset taxonomy and library routes (88 §3.4, D-69).
 *
 * The workshop is a distribution plane: discovery is partitioned by asset type
 * and every install lands in a local library. This module is the single source
 * of truth for the partition keys, how a manifest kind maps onto a partition
 * and which local route owns each type. It stays free of Node imports so both
 * the server pages and the client surfaces can share it.
 */

/** Discovery partitions, in display order (plan 88 §6.1 M2). */
export const WORKSHOP_ASSET_KINDS = [
  "pack",
  "pipeline",
  "source",
  "component",
  "template",
] as const;

export type WorkshopAssetKind = (typeof WORKSHOP_ASSET_KINDS)[number];

/** Manifest kinds that are assembled into a mold later, not run directly. */
export const COMPONENT_MANIFEST_KINDS = [
  "agent",
  "workflow",
  "toolpack",
  "skillpack",
] as const;

/** Discovery entry for each partition; every local library links here. */
export const DISCOVERY_HREF: Record<WorkshopAssetKind, string> = {
  pack: "/workshop?kind=pack",
  pipeline: "/workshop?kind=pipeline",
  source: "/workshop?kind=source",
  component: "/workshop?kind=component",
  template: "/workshop?kind=template",
};

/** Local library that receives an install for each partition. */
export const LIBRARY_HREF: Record<WorkshopAssetKind, string> = {
  pack: "/packs",
  pipeline: "/workshop?kind=pipeline",
  source: "/sources",
  component: "/workshop?kind=component",
  template: "/workshop?kind=template",
};

export function parseAssetKind(value: string | undefined): WorkshopAssetKind {
  return (WORKSHOP_ASSET_KINDS as readonly string[]).includes(value ?? "")
    ? (value as WorkshopAssetKind)
    : "pack";
}

/**
 * Map a `workshop.yaml` kind onto a discovery partition. Agent, workflow,
 * toolpack and skillpack manifests are components; everything else keeps its
 * own name. Unknown kinds return null and never match a partition.
 */
export function manifestAssetKind(kind: string): WorkshopAssetKind | null {
  if ((COMPONENT_MANIFEST_KINDS as readonly string[]).includes(kind)) {
    return "component";
  }
  if ((WORKSHOP_ASSET_KINDS as readonly string[]).includes(kind)) {
    return kind as WorkshopAssetKind;
  }
  return null;
}

export function matchesAssetKind(
  manifestKind: string,
  wanted: WorkshopAssetKind,
): boolean {
  return manifestAssetKind(manifestKind) === wanted;
}

/**
 * Where an install of this partition lands, e.g. `packs/radar`. `manifestKind`
 * and `host` refine component and pipeline paths (plan 88 §3.4).
 */
export function installDestination(
  kind: WorkshopAssetKind,
  id: string,
  manifestKind?: string,
  host?: string,
): string {
  switch (kind) {
    case "pack":
      return `packs/${id}`;
    case "source":
      return `sources/${id}`;
    case "component":
      return `components/${manifestKind ?? "<kind>"}/${id}`;
    case "pipeline":
      return `packs/${host || "<host>"}/workflows/${id}.yaml`;
    case "template":
      return `templates/${id}`;
  }
}

export interface WorkshopInstalledItem {
  /** Stable key for lists: `<library>:<id>`. */
  key: string;
  id: string;
  name: string;
  version: string;
  /** Manifest kind, e.g. `toolpack` for a component. */
  manifestKind: string;
  kind: WorkshopAssetKind;
  repo: string;
  commit: string;
  /** Library that owns the install on disk. */
  library: "packs" | "sources" | "components" | "templates" | "workshop";
  /** Local route that shows the installed item. */
  href: string;
}

export type WorkshopLibraryCounts = Record<WorkshopAssetKind, number>;

export type WorkshopLibraryTab = "discover" | "packs" | "sources";

/** Which library switcher tab a console pathname belongs to. */
export function activeLibraryTab(pathname: string): WorkshopLibraryTab {
  if (pathname === "/packs" || pathname.startsWith("/packs/")) {
    return "packs";
  }
  if (pathname === "/sources" || pathname.startsWith("/sources/")) {
    return "sources";
  }
  return "discover";
}
