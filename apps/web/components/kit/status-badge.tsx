"use client";

import { Badge } from "@/components/ui/badge";
import type { RunMode, RunStatus, StageStatus } from "@kit/core";
import { useTranslations } from "next-intl";

type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet";

const RUN_STATUS: Record<RunStatus, BadgeVariant> = {
  pending: "default",
  running: "success",
  succeeded: "success",
  failed: "danger",
  paused: "warning",
  cancelled: "default",
};

const STAGE_STATUS: Record<StageStatus, BadgeVariant> = {
  pending: "default",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "default",
};

const RUN_MODE: Record<RunMode, BadgeVariant> = {
  LIVE: "success",
  DRY_RUN: "default",
  SHADOW: "violet",
  REPLAY: "warning",
  FORK: "info",
  BACKFILL: "warning",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations("status");
  return <Badge variant={RUN_STATUS[status] ?? "default"}>{t(status)}</Badge>;
}

export function StageStatusBadge({ status }: { status: StageStatus }) {
  const t = useTranslations("status");
  return <Badge variant={STAGE_STATUS[status] ?? "default"}>{t(status)}</Badge>;
}

export function RunModeBadge({ mode }: { mode: RunMode }) {
  return <Badge variant={RUN_MODE[mode] ?? "default"}>{mode}</Badge>;
}
