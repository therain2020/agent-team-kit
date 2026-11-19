/**
 * Run-scoped observability deep links (D-67).
 *
 * `/traces` and the world drawer both resolve Jaeger and Temporal links from
 * the same place so the URL shape stays consistent. Backends are opt-in: when a
 * `NEXT_PUBLIC_*_UI_URL` is unset there is no localhost fallback, the link is
 * reported as disabled and callers render the env var name instead of a dead
 * href.
 */

export const JAEGER_UI_ENV = "NEXT_PUBLIC_JAEGER_UI_URL";
export const TEMPORAL_UI_ENV = "NEXT_PUBLIC_TEMPORAL_UI_URL";

export interface ObservabilityConfig {
  jaegerUiUrl?: string | null;
  temporalUiUrl?: string | null;
}

export type TraceTargetId = "jaegerWorker" | "jaegerCli" | "temporal";

export interface TraceTarget {
  id: TraceTargetId;
  /** Absolute deep link, or `null` when the backend is not configured. */
  href: string | null;
  envVar: string;
}

function baseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/**
 * Build the Jaeger (worker + CLI) and Temporal deep links for one run. The
 * target list and order are stable regardless of configuration so the UI can
 * render disabled cards in place.
 */
export function traceTargets(
  runId: string,
  config: ObservabilityConfig,
): TraceTarget[] {
  const jaeger = baseUrl(config.jaegerUiUrl);
  const temporal = baseUrl(config.temporalUiUrl);
  const tags = encodeURIComponent(JSON.stringify({ "run.id": runId }));

  return [
    {
      id: "jaegerWorker",
      href: jaeger ? `${jaeger}/search?service=kit-worker&tags=${tags}` : null,
      envVar: JAEGER_UI_ENV,
    },
    {
      id: "jaegerCli",
      href: jaeger ? `${jaeger}/search?service=kit-cli&tags=${tags}` : null,
      envVar: JAEGER_UI_ENV,
    },
    {
      id: "temporal",
      href: temporal
        ? `${temporal}/namespaces/default/workflows/pack-${encodeURIComponent(runId)}`
        : null,
      envVar: TEMPORAL_UI_ENV,
    },
  ];
}

/** Read the public backend URLs once for a server render. */
export function observabilityConfigFromEnv(): ObservabilityConfig {
  return {
    jaegerUiUrl: process.env.NEXT_PUBLIC_JAEGER_UI_URL,
    temporalUiUrl: process.env.NEXT_PUBLIC_TEMPORAL_UI_URL,
  };
}
