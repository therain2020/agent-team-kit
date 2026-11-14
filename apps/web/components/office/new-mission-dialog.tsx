"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { OfficeAgentView } from "@/lib/office";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const ROLE_LABEL = {
  builder: "roleBuilder",
  seller: "roleSeller",
  specialist: "roleSpecialist",
  manager: "roleManager",
} as const;

export function NewMissionDialog({
  open,
  onOpenChange,
  packDir,
  workflows,
  agents,
  roleRules,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packDir: string;
  workflows: Array<{ id: string; stages: number }>;
  agents: OfficeAgentView[];
  roleRules: {
    requireSeller: boolean;
    requireBuilder: boolean;
    allowCombined: boolean;
  };
}) {
  const t = useTranslations("newMission");
  const office = useTranslations("office");
  const router = useRouter();
  const [workflow, setWorkflow] = useState(workflows[0]?.id ?? "");
  const [manager, setManager] = useState("manager");
  const initialSeller =
    agents.find((agent) => agent.role === "seller")?.id ??
    (roleRules.allowCombined
      ? agents.find((agent) => !agent.isManager)?.id
      : undefined) ??
    "";
  const [seller, setSeller] = useState(initialSeller);
  const [builders, setBuilders] = useState<string[]>(
    agents.filter((agent) => agent.role === "builder").map((agent) => agent.id),
  );
  const [specialists, setSpecialists] = useState<string[]>([]);
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [evidence, setEvidence] = useState("");
  const [stub, setStub] = useState(true);
  const [pending, setPending] = useState(false);

  const sellerOptions = agents.filter(
    (agent) =>
      !agent.isManager && (agent.role === "seller" || roleRules.allowCombined),
  );
  const builderOptions = agents.filter(
    (agent) =>
      !agent.isManager && (agent.role === "builder" || roleRules.allowCombined),
  );
  const specialistOptions = agents.filter(
    (agent) => !agent.isManager && agent.role === "specialist",
  );
  const missingSeller = roleRules.requireSeller && !seller;
  const missingBuilder = roleRules.requireBuilder && builders.length === 0;
  const combinedConflict =
    !roleRules.allowCombined && Boolean(seller) && builders.includes(seller);

  function toggle(list: string[], id: string): string[] {
    return list.includes(id)
      ? list.filter((item) => item !== id)
      : [...list, id];
  }

  async function submit() {
    setPending(true);
    try {
      const assigned = [
        ...new Set([...(seller ? [seller] : []), ...builders, ...specialists]),
      ];
      const response = await fetch("/api/office/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packDir,
          workflow,
          manager,
          sellers: seller ? [seller] : [],
          builders,
          specialists,
          agents: assigned,
          acceptance,
          goal,
          evidenceText: evidence.trim() || undefined,
          stub,
        }),
      });
      const payload = (await response.json()) as {
        runId?: string;
        error?: string;
        details?: string[];
      };
      if (!response.ok || !payload.runId) {
        throw new Error(
          [payload.error, ...(payload.details ?? [])]
            .filter(Boolean)
            .join("\n") || t("failed"),
        );
      }
      toast.success(t("started", { runId: payload.runId }));
      onOpenChange(false);
      setGoal("");
      setAcceptance("");
      setEvidence("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[68vh] space-y-3 overflow-y-auto pr-1">
          <label
            htmlFor="mission-acceptance"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("acceptance")}
            <Textarea
              id="mission-acceptance"
              value={acceptance}
              onChange={(event) => setAcceptance(event.target.value)}
              rows={2}
              placeholder={t("acceptancePlaceholder")}
              className="text-[12px]"
            />
          </label>

          <label
            htmlFor="mission-goal"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("goal")}
            <Textarea
              id="mission-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              placeholder={t("goalPlaceholder")}
              className="text-[12px]"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label
              htmlFor="mission-workflow"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("workflow")}
              <select
                id="mission-workflow"
                value={workflow}
                onChange={(event) => setWorkflow(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
              >
                {workflows.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · {item.stages} stages
                  </option>
                ))}
              </select>
            </label>
            <label
              htmlFor="mission-manager"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("manager")}
              <select
                id="mission-manager"
                value={manager}
                onChange={(event) => setManager(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
              >
                <option value="manager">manager</option>
                {agents
                  .filter((agent) => !agent.isManager && agent.id !== "manager")
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.id}
                    </option>
                  ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label
              htmlFor="mission-seller"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("seller")}
              <select
                id="mission-seller"
                value={seller}
                onChange={(event) => setSeller(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
              >
                <option value="">{t("noSeller")}</option>
                {sellerOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.id} · {office(ROLE_LABEL[agent.role])}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("specialists")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {specialistOptions.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() =>
                      setSpecialists((current) => toggle(current, agent.id))
                    }
                    className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
                      specialists.includes(agent.id)
                        ? "border-violet-500/40 bg-violet-500/10 text-violet-200"
                        : "border-border text-zinc-500 hover:text-zinc-200"
                    }`}
                  >
                    {agent.id}
                  </button>
                ))}
                {specialistOptions.length === 0 ? (
                  <span className="text-[10px] text-zinc-600">
                    {t("noSpecialists")}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">
              {t("builders")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {builderOptions.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() =>
                    setBuilders((current) => toggle(current, agent.id))
                  }
                  className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
                    builders.includes(agent.id)
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : "border-border text-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  {agent.id}
                </button>
              ))}
              {builderOptions.length === 0 ? (
                <span className="text-[10px] text-red-300">
                  {t("noBuilders")}
                </span>
              ) : null}
            </div>
          </div>

          <p className="rounded border border-border bg-zinc-950/40 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-500">
            {t("roleRules", {
              seller: roleRules.requireSeller ? t("required") : t("optional"),
              builder: roleRules.requireBuilder ? t("required") : t("optional"),
              combined: roleRules.allowCombined ? t("allowed") : t("forbidden"),
            })}
          </p>

          <label
            htmlFor="mission-evidence"
            className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
          >
            {t("evidence")}
            <Textarea
              id="mission-evidence"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              rows={4}
              placeholder='{"sources":[{"citationId":"S1","title":"…","url":"…"}],"errors":[]}'
              className="font-mono text-[10px]"
            />
          </label>

          <div className="flex items-center justify-between rounded border border-border px-2 py-1.5">
            <label className="flex items-center gap-2 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                checked={stub}
                onChange={(event) => setStub(event.target.checked)}
                className="size-3.5 accent-emerald-500"
              />
              {t("stub")}
            </label>
            <span className="text-[10px] text-zinc-600">{t("stubHint")}</span>
          </div>

          {missingSeller || missingBuilder || combinedConflict ? (
            <p className="rounded border border-red-500/25 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-300">
              {missingSeller
                ? t("sellerRequired")
                : missingBuilder
                  ? t("builderRequired")
                  : t("combinedForbidden")}
            </p>
          ) : null}

          <p className="text-[10px] leading-relaxed text-zinc-600">
            {t("assignmentNote")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={
              pending ||
              !workflow ||
              missingSeller ||
              missingBuilder ||
              combinedConflict
            }
          >
            {pending ? t("starting") : t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
