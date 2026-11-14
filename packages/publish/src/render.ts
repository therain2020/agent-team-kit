import { escapeText, renderMarkdown, stripLeadingHeading } from "./markdown";
import { FAVICON_SVG, SITE_CSS } from "./theme";
import type {
  PublishedArtifact,
  PublishedRun,
  SiteIndex,
  SiteOptions,
  SiteRunEntry,
} from "./types";

export { FAVICON_SVG, SITE_CSS };
export { renderMarkdown };

export function runSiteEntry(run: PublishedRun): SiteRunEntry {
  return {
    runId: run.runId,
    title: run.title,
    summary: run.summary,
    workflowId: run.workflowId,
    status: run.status,
    runMode: run.runMode,
    createdAt: run.createdAt,
    artifactCount: run.artifacts.length,
    costCny: run.costCny,
    path: `${runDirectory(run.runId)}/index.html`,
  };
}

export function mergeSiteIndex(
  existing: SiteIndex | null,
  run: PublishedRun,
  options: SiteOptions,
): SiteIndex {
  const entry = runSiteEntry(run);
  const runs = [
    entry,
    ...(existing?.runs ?? []).filter((item) => item.runId !== run.runId),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    version: 1,
    title: options.title,
    description: options.description,
    updatedAt: new Date().toISOString(),
    runs,
  };
}

export function renderRunFiles(
  run: PublishedRun,
  options: SiteOptions,
): Record<string, string> {
  const directory = runDirectory(run.runId);
  const files: Record<string, string> = {
    [`${directory}/index.html`]: renderRunPage(run, options),
  };

  for (const artifact of run.artifacts) {
    files[`${directory}/${artifactFileName(artifact.artifactId)}.html`] =
      renderArtifactPage(run, artifact, options);
  }

  return files;
}

export function renderSiteIndex(site: SiteIndex, options: SiteOptions): string {
  const artifactCount = site.runs.reduce(
    (sum, run) => sum + run.artifactCount,
    0,
  );
  const totalCost = site.runs.reduce((sum, run) => sum + run.costCny, 0);
  const cards = site.runs
    .map((run) => {
      const status = statusBadge(run.status);
      return `<a class="run-card" href="${escapeAttribute(run.path)}">
  <div class="badges">${status}${modeBadge(run.runMode)}</div>
  <div class="run-title">${escapeText(run.title)}</div>
  <div class="run-summary">${escapeText(run.summary || `${run.workflowId} · ${run.status}`)}</div>
  <div class="run-meta">
    <span class="mono">${escapeText(run.workflowId)}</span>
    <span>${formatDate(run.createdAt)}</span>
    <span>${run.artifactCount} artifact${run.artifactCount === 1 ? "" : "s"}</span>
    <span>${formatCny(run.costCny)}</span>
  </div>
</a>`;
    })
    .join("\n");

  const body = `<section class="hero">
  <p class="eyebrow">Public run archive</p>
  <h1>${escapeText(site.title)}</h1>
  <p>${escapeText(site.description)}</p>
  <div class="links">
    ${
      options.repoUrl
        ? `<a class="button primary" href="${escapeAttribute(options.repoUrl)}" target="_blank" rel="noreferrer noopener">Repository ↗</a>`
        : ""
    }
    <a class="button" href="https://github.com/therain2020/agent-team-kit" target="_blank" rel="noreferrer noopener">Agent Team Kit</a>
  </div>
</section>
<div class="metrics">
  <div class="metric"><p class="metric-label">Runs</p><p class="metric-value">${site.runs.length}</p></div>
  <div class="metric"><p class="metric-label">Artifacts</p><p class="metric-value">${artifactCount}</p></div>
  <div class="metric"><p class="metric-label">Total cost</p><p class="metric-value">${formatCny(totalCost)}</p></div>
  <div class="metric"><p class="metric-label">Updated</p><p class="metric-value" style="font-size:13px">${formatDate(site.updatedAt)}</p></div>
</div>
${
  site.runs.length > 0
    ? `<div class="cards">${cards}</div>`
    : `<div class="empty">No published runs yet. Publish one with <code>kit publish &lt;runId&gt; --push --yes</code>.</div>`
}`;

  return layout({
    lang: "en",
    title: site.title,
    description: site.description,
    root: "",
    site: options,
    crumbs: [{ label: site.title }],
    nav: [
      {
        href: "index.html",
        label: "All runs",
        active: true,
        dot: "success",
      },
      ...(options.repoUrl
        ? [{ href: options.repoUrl, label: "Repository ↗", external: true }]
        : []),
    ],
    contextRight: `<span class="badge outline">${site.runs.length} run${site.runs.length === 1 ? "" : "s"}</span>`,
    body,
    canonical: options.baseUrl ? normalizeBase(options.baseUrl) : undefined,
    ogType: "website",
  });
}

export function renderNotFound(options: SiteOptions): string {
  return layout({
    lang: "en",
    title: "Page not found",
    description: "This page does not exist in the published run archive.",
    root: "",
    site: options,
    crumbs: [{ label: "Page not found" }],
    nav: [{ href: "index.html", label: "All runs", active: true }],
    body: `<div class="page-header">
  <p class="eyebrow">404</p>
  <h1 class="page-title">Page not found</h1>
  <p class="page-summary">The run or artifact you followed no longer exists in this archive.</p>
</div>
<a class="button primary" href="index.html">Back to all runs</a>`,
    ogType: "website",
  });
}

function renderRunPage(run: PublishedRun, options: SiteOptions): string {
  const root = "../../";
  const warning =
    run.runMode !== "LIVE"
      ? `<div class="notice">This run was not executed in LIVE mode (${escapeText(run.runMode)}). External side effects were disabled; artifacts are for inspection.</div>`
      : "";

  const stages = run.stages.length
    ? `<ol class="timeline">${run.stages
        .map((stage) => {
          const artifacts = stage.artifactIds
            .map((artifactId) =>
              run.artifacts.find((item) => item.artifactId === artifactId),
            )
            .filter((item): item is PublishedArtifact => Boolean(item))
            .map(
              (artifact) =>
                `<a class="chip" href="./${escapeAttribute(artifactFileName(artifact.artifactId))}.html" title="${escapeAttribute(artifact.artifactId)}">${escapeText(artifact.title)}</a>`,
            )
            .join("");
          const duration = formatDuration(
            millisecondsBetween(stage.startedAt, stage.finishedAt),
          );
          return `<li class="stage ${escapeAttribute(stage.status)}">
  <span class="stage-dot" aria-hidden="true"></span>
  <div class="stage-head">
    <span class="stage-name">${escapeText(stage.name)}</span>
    ${statusBadge(stage.status)}
    ${duration !== "—" ? `<span class="stage-meta">${duration}</span>` : ""}
    ${stage.startedAt ? `<span class="stage-meta">${formatDate(stage.startedAt)}</span>` : ""}
  </div>
  ${stage.error ? `<p class="stage-error">${escapeText(stage.error)}</p>` : ""}
  ${artifacts ? `<div class="stage-artifacts">${artifacts}</div>` : ""}
</li>`;
        })
        .join("")}</ol>`
    : `<div class="empty">No stages were recorded for this run.</div>`;

  const artifactCards = run.artifacts
    .map(
      (
        artifact,
      ) => `<a class="artifact-card" href="./${escapeAttribute(artifactFileName(artifact.artifactId))}.html">
  <div class="badges">${kindBadge(artifact.kind)}${modeBadge(run.runMode)}</div>
  <div class="title">${escapeText(artifact.title)}</div>
  <div class="summary">${escapeText(artifact.summary || artifact.stageName)}</div>
  <div class="meta">
    <span class="mono">${escapeText(artifact.agentId)}</span>
    <span class="mono">${escapeText(artifact.modelId)}</span>
    <span>${formatCny(artifact.costCny)}</span>
  </div>
</a>`,
    )
    .join("\n");

  const body = `<div class="page-header">
  <p class="eyebrow">Run · ${escapeText(run.workflowId)}</p>
  <h1 class="page-title">${escapeText(run.title)}</h1>
  <p class="page-summary">${escapeText(run.summary)}</p>
  <div class="badges">
    ${statusBadge(run.status)}
    ${modeBadge(run.runMode)}
    <span class="badge outline mono">${escapeText(run.workflowId)}</span>
    <span class="badge outline mono">${escapeText(run.workspaceId)}</span>
    <span class="badge outline">${formatDate(run.createdAt)}</span>
  </div>
</div>
${warning}
<div class="metrics">
  <div class="metric"><p class="metric-label">Cost</p><p class="metric-value">${formatCny(run.costCny)}</p><p class="metric-hint">model usage</p></div>
  <div class="metric"><p class="metric-label">Tokens</p><p class="metric-value">${formatTokens(run.tokens)}</p><p class="metric-hint">input + output</p></div>
  <div class="metric"><p class="metric-label">Duration</p><p class="metric-value">${formatDuration(run.durationMs)}</p><p class="metric-hint">stage time</p></div>
  <div class="metric"><p class="metric-label">Artifacts</p><p class="metric-value">${run.artifacts.length}</p><p class="metric-hint">published</p></div>
</div>
<section class="panel">
  <h2 class="panel-title">Stages <span class="count">${run.stages.length}</span></h2>
  ${stages}
</section>
<section class="panel" id="artifacts">
  <h2 class="panel-title">Artifacts <span class="count">${run.artifacts.length}</span></h2>
  ${artifactCards ? `<div class="artifact-grid">${artifactCards}</div>` : `<div class="empty">No publishable artifacts.</div>`}
</section>`;

  return layout({
    lang: detectLanguage(run.summary + run.title),
    title: run.title,
    description: run.summary,
    root,
    site: options,
    crumbs: [
      { label: "All runs", href: `${root}index.html` },
      { label: run.title },
    ],
    nav: runNav(run, root),
    contextRight: statusPill(run.status),
    body,
    canonical: options.baseUrl
      ? `${normalizeBase(options.baseUrl)}${runDirectory(run.runId)}/`
      : undefined,
    ogType: "article",
  });
}

function renderArtifactPage(
  run: PublishedRun,
  artifact: PublishedArtifact,
  options: SiteOptions,
): string {
  const root = "../../";
  const file = `${artifactFileName(artifact.artifactId)}.html`;
  const content = renderMarkdown(
    stripLeadingHeading(artifact.markdown, artifact.title),
  );
  const raw = `<details class="raw"><summary>Raw Markdown</summary><pre>${escapeText(artifact.raw)}</pre></details>`;

  const body = `<div class="page-header">
  <p class="eyebrow">Artifact · ${escapeText(artifact.stageName)}</p>
  <h1 class="page-title">${escapeText(artifact.title)}</h1>
  ${artifact.summary ? `<p class="page-summary">${escapeText(artifact.summary)}</p>` : ""}
  <div class="badges">
    ${kindBadge(artifact.kind)}
    ${modeBadge(run.runMode)}
    <span class="badge outline mono">${escapeText(artifact.stageName)}</span>
    <span class="badge outline">${formatDate(artifact.createdAt)}</span>
  </div>
</div>
${artifact.truncated ? `<div class="notice">This artifact was truncated for publication. Open the original in the console for the full text.</div>` : ""}
<div class="artifact-layout">
  <div>
    <article class="prose">${content}</article>
    ${raw}
  </div>
  <aside class="provenance" aria-label="Provenance">
    <h2>Provenance</h2>
    ${provenanceRow("Agent", artifact.agentId)}
    ${provenanceRow("Model", artifact.modelId)}
    ${provenanceRow("Stage", artifact.stageName)}
    ${provenanceRow("Kind", kindLabel(artifact.kind))}
    ${provenanceRow("Created", formatDate(artifact.createdAt))}
    ${provenanceRow("Cost", formatCny(artifact.costCny))}
    ${provenanceRow("Tokens", formatTokens(artifact.tokens))}
    ${provenanceRow("Artifact", artifact.artifactId)}
    ${provenanceRow("Version", `v${artifact.version}`)}
    ${provenanceRow("Run mode", run.runMode)}
  </aside>
</div>`;

  return layout({
    lang: detectLanguage(artifact.markdown + artifact.title),
    title: artifact.title,
    description: artifact.summary || `${artifact.title} · ${run.title}`,
    root,
    site: options,
    crumbs: [
      { label: "All runs", href: `${root}index.html` },
      { label: run.title, href: "./index.html" },
      { label: artifact.title },
    ],
    nav: runNav(run, root, file),
    contextRight: statusPill(run.status),
    body,
    canonical: options.baseUrl
      ? `${normalizeBase(options.baseUrl)}${runDirectory(run.runId)}/${file}`
      : undefined,
    ogType: "article",
  });
}

function runNav(
  run: PublishedRun,
  root: string,
  activeFile?: string,
): Array<{ href: string; label: string; active?: boolean; dot?: string }> {
  const artifacts = run.artifacts.slice(0, 8).map((artifact) => ({
    href: `./${artifactFileName(artifact.artifactId)}.html`,
    label: truncate(artifact.title, 34),
    active: activeFile === `${artifactFileName(artifact.artifactId)}.html`,
  }));
  return [
    { href: `${root}index.html`, label: "All runs" },
    { href: "./index.html", label: "Current run", active: !activeFile },
    ...artifacts,
  ];
}

interface LayoutInput {
  lang: string;
  title: string;
  description: string;
  root: string;
  site: SiteOptions;
  crumbs: Array<{ label: string; href?: string }>;
  nav: Array<{
    href: string;
    label: string;
    active?: boolean;
    dot?: string;
    external?: boolean;
  }>;
  contextRight?: string;
  body: string;
  canonical?: string;
  ogType: string;
}

function layout(input: LayoutInput): string {
  const canonical = input.canonical
    ? `<link rel="canonical" href="${escapeAttribute(input.canonical)}" />`
    : "";
  const canonicalMeta = input.canonical
    ? `<meta property="og:url" content="${escapeAttribute(input.canonical)}" />`
    : "";
  const nav = input.nav
    .map((item) => {
      const external = item.external
        ? ` target="_blank" rel="noreferrer noopener"`
        : "";
      const dot = item.dot
        ? `<span class="dot ${item.dot}" aria-hidden="true"></span>`
        : "";
      return `<a href="${escapeAttribute(item.href)}"${item.active ? ` class="active" aria-current="page"` : ""}${external}>${dot}${escapeText(item.label)}</a>`;
    })
    .join("");

  const crumbs = input.crumbs
    .map((crumb, index) => {
      const isLast = index === input.crumbs.length - 1;
      if (isLast) {
        return `<span class="current">${escapeText(crumb.label)}</span>`;
      }
      return crumb.href
        ? `<a href="${escapeAttribute(crumb.href)}">${escapeText(crumb.label)}</a><span class="sep">/</span>`
        : `<span>${escapeText(crumb.label)}</span><span class="sep">/</span>`;
    })
    .join("");

  return `<!doctype html>
<html lang="${input.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(input.title)} · Agent Team Kit</title>
<meta name="description" content="${escapeAttribute(input.description)}" />
<meta name="generator" content="Agent Team Kit" />
<meta name="theme-color" content="#09090b" />
<meta property="og:type" content="${input.ogType}" />
<meta property="og:site_name" content="${escapeAttribute(input.site.title)}" />
<meta property="og:title" content="${escapeAttribute(input.title)}" />
<meta property="og:description" content="${escapeAttribute(input.description)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escapeAttribute(input.title)}" />
<meta name="twitter:description" content="${escapeAttribute(input.description)}" />
${canonical}
${canonicalMeta}
<link rel="icon" href="${input.root}assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="${input.root}assets/site.css" />
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Agent Team Kit</span></div>
    <p class="brand-sub">Published runs</p>
    <nav class="nav" aria-label="Site navigation">
      <span class="nav-label">Archive</span>
      ${nav}
    </nav>
    <div class="sidebar-foot">Static glass box<br/>No server · no telemetry</div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div class="crumbs">${crumbs}</div>
      <div class="status">${input.contextRight ?? ""}</div>
    </header>
    <main class="content" id="main">
      ${input.body}
    </main>
    <footer class="footer">
      <span>Generated by Agent Team Kit · artifacts published as-is · tool and approval internals excluded</span>
      ${input.site.repoUrl ? `<a href="${escapeAttribute(input.site.repoUrl)}" target="_blank" rel="noreferrer noopener">Source repository</a>` : ""}
    </footer>
  </div>
</div>
</body>
</html>`;
}

function provenanceRow(key: string, value: string): string {
  return `<div class="prov-row"><span class="prov-key">${escapeText(key)}</span><span class="prov-value">${escapeText(value)}</span></div>`;
}

function statusBadge(status: string): string {
  return `<span class="badge ${statusVariant(status)}">${escapeText(statusLabel(status))}</span>`;
}

function modeBadge(mode: string): string {
  return `<span class="badge ${modeVariant(mode)}">${escapeText(mode)}</span>`;
}

function kindBadge(kind: string): string {
  return `<span class="badge outline">${escapeText(kindLabel(kind))}</span>`;
}

function statusPill(status: string): string {
  return `<span class="status-pill ${statusVariant(status)}">${escapeText(statusLabel(status))}</span>`;
}

function statusVariant(status: string): string {
  switch (status) {
    case "succeeded":
      return "success";
    case "running":
      return "info";
    case "failed":
      return "danger";
    case "paused":
      return "warning";
    default:
      return "";
  }
}

function modeVariant(mode: string): string {
  switch (mode) {
    case "LIVE":
      return "success";
    case "SHADOW":
      return "violet";
    case "REPLAY":
    case "BACKFILL":
      return "warning";
    case "FORK":
      return "info";
    default:
      return "outline";
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "report":
      return "Report";
    case "revision":
      return "Revision";
    default:
      return "Artifact";
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCny(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "¥0";
  }
  const fixed = amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `¥${fixed || "0"}`;
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(tokens)));
}

function millisecondsBetween(start?: string, end?: string): number {
  if (!start || !end) {
    return 0;
  }
  const delta = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

function artifactFileName(artifactId: string): string {
  return safeSegment(artifactId);
}

function runDirectory(runId: string): string {
  return `runs/${safeSegment(runId)}`;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "item";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function detectLanguage(text: string): "en" | "zh" {
  const cjk = text.match(/[一-鿿]/g)?.length ?? 0;
  return cjk > 12 && cjk / Math.max(1, text.length) > 0.12 ? "zh" : "en";
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll("'", "&#39;");
}
