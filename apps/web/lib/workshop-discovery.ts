import { listTemplates } from "@kit/pack";
import { BUILTIN_SOURCES } from "@kit/source";
import { type WorkshopInstallRecord, listComponents } from "@kit/workshop";
import { listPacks } from "./packs";
import { getComponentsRoot } from "./paths";
import { loadInstalledSources } from "./sources";
import { loadInstalledWorkshop } from "./workshop";
import {
  LIBRARY_HREF,
  type WorkshopAssetKind,
  type WorkshopInstalledItem,
  type WorkshopLibraryCounts,
  manifestAssetKind,
} from "./workshop-library";
import type { InstalledSourceView } from "./workshop-link";

/**
 * Server read model for the workshop discovery center (88 §3.4, §6.1 M2).
 *
 * The discovery center does not own installs: it partitions GitHub discoveries
 * by asset type and reports where every installed item actually lives, so the
 * "installed" list links back into `/packs`, `/sources`, `components/`,
 * `templates/` or `workshop/` staging. Nothing here mutates disk.
 */

export interface WorkshopDiscoveryData {
  installed: WorkshopInstalledItem[];
  counts: WorkshopLibraryCounts;
}

export async function loadWorkshopDiscovery(): Promise<WorkshopDiscoveryData> {
  const [packs, sources, staged, components, templates] = await Promise.all([
    listPacks(),
    loadInstalledSources(),
    loadInstalledWorkshop(),
    listComponents(getComponentsRoot()),
    listTemplates(),
  ]);

  const packDirs = new Set(packs.flatMap((pack) => [pack.dirName, pack.name]));
  const legacy = staged.filter(
    (record) =>
      record.kind !== "pack" ||
      (!packDirs.has(record.id) && !packDirs.has(record.dirName)),
  );

  const componentIds = new Set(components.map((entry) => entry.id));
  const installed: WorkshopInstalledItem[] = [];

  for (const pack of packs) {
    if (!pack.workshop) {
      continue;
    }
    installed.push({
      key: `packs:${pack.dirName}`,
      id: pack.dirName,
      name: pack.name,
      version: pack.version,
      manifestKind: "pack",
      kind: "pack",
      repo: pack.workshop.repo,
      commit: pack.workshop.commit,
      library: "packs",
      href: `/packs?pack=${encodeURIComponent(pack.dirName)}`,
    });
  }

  for (const source of sources) {
    installed.push({
      key: `sources:${source.definition.metadata.name}`,
      id: source.definition.metadata.name,
      name: source.definition.metadata.name,
      version: source.definition.metadata.version,
      manifestKind: "source",
      kind: "source",
      repo: source.meta.repo,
      commit: source.meta.commit,
      library: "sources",
      href: "/sources",
    });
  }

  for (const component of components) {
    if (!component.provenance) {
      continue;
    }
    installed.push({
      key: `components:${component.kind}/${component.id}`,
      id: `${component.kind}/${component.id}`,
      name: component.id,
      version: component.version ?? "",
      manifestKind: component.kind,
      kind: "component",
      repo: component.provenance.repo,
      commit: component.provenance.commit,
      library: "components",
      href: LIBRARY_HREF.component,
    });
  }

  const stagedTemplates: WorkshopInstallRecord[] = [];
  const stagedComponents: WorkshopInstallRecord[] = [];
  const stagedPipelines: WorkshopInstallRecord[] = [];
  for (const record of legacy) {
    const kind = manifestAssetKind(record.kind);
    if (!kind) {
      continue;
    }
    if (kind === "component") {
      if (componentIds.has(record.id)) {
        continue;
      }
      stagedComponents.push(record);
    } else if (kind === "template") {
      stagedTemplates.push(record);
    } else if (kind === "pipeline") {
      stagedPipelines.push(record);
    } else {
      continue;
    }
    installed.push(stagedItem(record, kind));
  }

  return {
    installed,
    counts: {
      pack: packs.length,
      pipeline: stagedPipelines.length,
      source: sources.length + BUILTIN_SOURCES.length,
      component: components.length + stagedComponents.length,
      template: templates.length + stagedTemplates.length,
    },
  };
}

function stagedItem(
  record: WorkshopInstallRecord,
  kind: WorkshopAssetKind,
): WorkshopInstalledItem {
  return {
    key: `workshop:${record.dirName}`,
    id: record.id,
    name: record.name,
    version: record.version,
    manifestKind: record.kind,
    kind,
    repo: record.repo,
    commit: record.commit,
    library: "workshop",
    href: LIBRARY_HREF[kind],
  };
}

/** Third-party sources as the discovery panel and source library show them. */
export async function loadInstalledSourceViews(): Promise<
  InstalledSourceView[]
> {
  const sources = await loadInstalledSources();
  return sources.map((source) => ({
    name: source.definition.metadata.name,
    version: source.definition.metadata.version,
    description: source.definition.metadata.description ?? "",
    homepage: source.definition.metadata.homepage,
    license: source.definition.metadata.license,
    repo: source.meta.repo,
    commit: source.meta.commit,
    trust: source.meta.trust,
  }));
}
