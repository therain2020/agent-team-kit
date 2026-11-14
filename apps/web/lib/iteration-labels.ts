"use client";

import { useTranslations } from "next-intl";

const STATUS_KEYS = [
  "pending",
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "applied",
  "passed",
  "done",
  "completed",
  "blocked",
  "reverted",
  "applying",
  "stalled",
] as const;

type StatusKey = (typeof STATUS_KEYS)[number];
const STATUS_SET = new Set<string>(STATUS_KEYS);

export function useStatusLabel(): (status: string) => string {
  const t = useTranslations("status");
  return (status: string) =>
    STATUS_SET.has(status) ? t(status as StatusKey) : status;
}

const RISK_KEYS = ["low", "medium", "high"] as const;

type RiskKey = (typeof RISK_KEYS)[number];
const RISK_SET = new Set<string>(RISK_KEYS);

export function useRiskLabel(): (risk: string) => string {
  const t = useTranslations("risk");
  return (risk: string) => (RISK_SET.has(risk) ? t(risk as RiskKey) : risk);
}
