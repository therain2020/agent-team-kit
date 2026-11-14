"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { StudioAgent, StudioData, StudioStage } from "@/lib/pack-studio";
import { cn } from "@/lib/utils";
import {
  Bot,
  CheckCircle2,
  FileCode2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  UserCog,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useId,
  useState,
} from "react";
import { toast } from "sonner";
import { WorkflowGraph } from "./workflow-graph";

type Tab = "agents" | "workflows" | "approvals" | "autopilot";

interface ApprovalDraft {
  enabled: boolean;
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttl: string;
  maxRunCostCny: string;
}

interface PolicyApproval {
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttl: string;
  autoApproveWhen?: { maxRunCostCny: number };
}

interface PolicyRow {
  file: string;
  stageId: string;
  stageType: string;
  agent?: string;
  approval: PolicyApproval | null;
  reason: string;
}

interface PolicyResult {
  policies: PolicyRow[];
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

export function PackStudio({
  data,
  initialAgentId,
}: {
  data: StudioData;
  initialAgentId?: string;
}) {
  const t = useTranslations("studio");
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState(data.agents);
  const [selectedId, setSelectedId] = useState(
    data.agents.find((agent) => agent.id === initialAgentId)?.id ??
      data.agents[0]?.id ??
      "manager",
  );
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [workflowFile, setWorkflowFile] = useState(
    data.workflows[0]?.file ?? "",
  );
  const [workflowRaw, setWorkflowRaw] = useState(data.workflows[0]?.raw ?? "");
  const [autopilotRaw, setAutopilotRaw] = useState(data.autopilotRaw);
  const [approvalDrafts, setApprovalDrafts] = useState<
    Record<string, ApprovalDraft>
  >(() => buildApprovalDrafts(data));
  const [policyIntent, setPolicyIntent] = useState("");
  const [policy, setPolicy] = useState<PolicyResult | null>(null);
  const [policyBusy, setPolicyBusy] = useState<"draft" | "apply" | null>(null);
  const [policyExcluded, setPolicyExcluded] = useState<Record<string, boolean>>(
    {},
  );
  const [newAgent, setNewAgent] = useState({
    id: "",
    description: "",
    model: "deepseek-flash",
    role: "builder" as StudioAgent["role"],
  });
  const [newWorkflowId, setNewWorkflowId] = useState("workflow-2");
  const [workflowBusy, setWorkflowBusy] = useState(false);

  const currentWorkflow = data.workflows.find(
    (workflow) => workflow.file === workflowFile,
  );

  function patchAgent(patch: Partial<StudioAgent>) {
    if (!selected) {
      return;
    }
    setAgents((current) =>
      current.map((agent) =>
        agent.id === selected.id ? { ...agent, ...patch } : agent,
      ),
    );
  }

  async function saveAgent() {
    if (!selected) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/agents/${encodeURIComponent(selected.id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            description: selected.description,
            model: selected.model,
            role: selected.role,
            tools: selected.tools,
            skills: selected.skills,
            permissions: selected.permissions,
            instructions: selected.instructions,
          }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        details?: string[];
      };
      if (!response.ok) {
        throw new Error(
          [payload.error, ...(payload.details ?? [])]
            .filter(Boolean)
            .join("\n"),
        );
      }
      toast.success(t("saved"));
      setMessage(t("validated"));
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function addAgent() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/agents`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(newAgent),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "create failed");
      }
      toast.success(t("agentCreated"));
      setNewAgent({
        id: "",
        description: "",
        model: "deepseek-flash",
        role: "builder",
      });
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function saveWorkflow() {
    if (!workflowFile) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/workflow`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: workflowFile, content: workflowRaw }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "save failed");
      }
      toast.success(t("saved"));
      setMessage(t("validated"));
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function addWorkflow() {
    const id = newWorkflowId.trim();
    if (!id) {
      return;
    }
    setWorkflowBusy(true);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/workflow`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "create failed");
      }
      toast.success(t("workflowCreated"));
      window.location.reload();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("validationFailed"),
      );
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function renameCurrentWorkflow() {
    if (!currentWorkflow) {
      return;
    }
    const newId = window.prompt(t("renameWorkflowPrompt"), currentWorkflow.id);
    if (!newId || newId === currentWorkflow.id) {
      return;
    }
    setWorkflowBusy(true);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/workflow`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            file: currentWorkflow.file,
            newFile: `workflows/${newId}.yaml`,
            newId,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "rename failed");
      }
      toast.success(t("saved"));
      window.location.reload();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("validationFailed"),
      );
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function deleteCurrentWorkflow() {
    if (!currentWorkflow) {
      return;
    }
    if (
      !window.confirm(t("confirmDeleteWorkflow", { id: currentWorkflow.id }))
    ) {
      return;
    }
    setWorkflowBusy(true);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/workflow`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: currentWorkflow.file }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "delete failed");
      }
      toast.success(t("workflowDeleted"));
      window.location.reload();
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("validationFailed"),
      );
    } finally {
      setWorkflowBusy(false);
    }
  }

  async function saveAutopilot() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/autopilot`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          // The raw editor is an explicit expert save; the API still blocks
          // high-risk auto-approval and requires this flag for LIVE/enabled.
          body: JSON.stringify({ content: autopilotRaw, confirmRisk: true }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "save failed");
      }
      toast.success(t("saved"));
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function saveApproval(workflow: { file: string }, stage: StudioStage) {
    const key = `${workflow.file}:${stage.id}`;
    const draft = approvalDrafts[key];
    if (!draft) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const approval = draft.enabled
        ? {
            mode: draft.mode,
            position: draft.position,
            riskClass: draft.riskClass,
            ttl: draft.ttl,
            ...(draft.mode === "auto" && draft.maxRunCostCny.trim()
              ? {
                  autoApproveWhen: {
                    maxRunCostCny: Number(draft.maxRunCostCny),
                  },
                }
              : {}),
          }
        : null;
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/approval`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            file: workflow.file,
            stageId: stage.id,
            approval,
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "save failed");
      }
      toast.success(t("saved"));
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setSaving(false);
    }
  }

  async function generatePolicy() {
    if (!policyIntent.trim()) {
      toast.error(t("policyHint"));
      return;
    }
    setPolicyBusy("draft");
    setError(null);
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "approvalPolicy",
          intent: policyIntent.trim(),
          packDir: data.dirName,
        }),
      });
      const payload = (await response.json()) as {
        values?: { policies?: PolicyRow[] };
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values?.policies) {
        throw new Error(payload.error ?? "failed to generate policy");
      }
      setPolicy({
        policies: payload.values.policies,
        rationale: payload.rationale ?? "",
        warnings: payload.warnings ?? [],
        model: payload.model === "live" ? "live" : "heuristic",
      });
      setPolicyExcluded({});
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setPolicyBusy(null);
    }
  }

  async function applyPolicy() {
    if (!policy) {
      return;
    }
    const selected = policy.policies.filter(
      (row) => !policyExcluded[`${row.file}:${row.stageId}`],
    );
    if (selected.length === 0) {
      toast.error(t("policyHint"));
      return;
    }
    setPolicyBusy("apply");
    setError(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/approval`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            approvals: selected.map((row) => ({
              file: row.file,
              stageId: row.stageId,
              approval: row.approval,
            })),
          }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "apply failed");
      }
      setApprovalDrafts((current) => {
        const next = { ...current };
        for (const row of selected) {
          next[`${row.file}:${row.stageId}`] = draftFromPolicy(row);
        }
        return next;
      });
      toast.success(t("policyApplied"));
      router.refresh();
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : String(problem);
      setError(text);
      toast.error(text);
    } finally {
      setPolicyBusy(null);
    }
  }

  async function validate() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(data.dirName)}/validate`,
      );
      const payload = (await response.json()) as {
        ok: boolean;
        errors?: string[];
        warnings?: string[];
      };
      if (payload.ok) {
        setMessage(
          t("validatedWithWarnings", { count: payload.warnings?.length ?? 0 }),
        );
        toast.success(t("validated"));
      } else {
        setError((payload.errors ?? []).join("\n"));
        toast.error(t("validationFailed"));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
          {(
            [
              ["agents", UserCog],
              ["workflows", FileCode2],
              ["approvals", ShieldCheck],
              ["autopilot", Sparkles],
            ] as Array<[Tab, typeof UserCog]>
          ).map(([value, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-100",
                tab === value && "bg-zinc-800 text-zinc-100",
              )}
            >
              <Icon className="size-3.5" />
              {t(`tabs.${value}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/packs/${encodeURIComponent(data.dirName)}`}>
            <Button variant="ghost" size="sm">
              {t("viewPack")}
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={validate}
            disabled={saving}
          >
            <RefreshCw className="size-3.5" />
            {t("validate")}
          </Button>
        </div>
      </div>

      {error ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {error}
        </pre>
      ) : null}
      {message ? (
        <p className="flex items-center gap-1.5 rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300">
          <CheckCircle2 className="size-3.5" />
          {message}
        </p>
      ) : null}
      {data.warnings.length > 0 ? (
        <p className="text-[11px] text-amber-300/80">
          {t("warnings", {
            count: data.warnings.length,
            first: data.warnings[0] ?? "",
          })}
        </p>
      ) : null}

      {tab === "agents" && selected ? (
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="rounded-lg border border-border bg-card p-2">
              <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-500">
                {t("agents")}
              </p>
              <button
                type="button"
                onClick={() => setSelectedId(selected.id)}
                className="mb-1 flex w-full items-center gap-2 rounded-md bg-zinc-900 px-2 py-1.5 text-left text-xs text-zinc-200"
              >
                <Bot className="size-3.5 text-emerald-400" />
                <span className="flex-1 truncate">{selected.id}</span>
                {selected.isManager ? (
                  <Badge variant="violet">{t("manager")}</Badge>
                ) : null}
              </button>
              {agents
                .filter((agent) => agent.id !== selected.id)
                .map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setSelectedId(agent.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                  >
                    <UserCog className="size-3.5" />
                    <span className="flex-1 truncate">{agent.id}</span>
                    {agent.isManager ? (
                      <Badge variant="violet">{t("manager")}</Badge>
                    ) : null}
                  </button>
                ))}
            </div>

            <div className="rounded-lg border border-border bg-card p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] text-zinc-300">
                <Plus className="size-3.5" />
                {t("newAgent")}
              </p>
              <div className="space-y-1.5">
                <Input
                  value={newAgent.id}
                  onChange={(event) =>
                    setNewAgent((current) => ({
                      ...current,
                      id: event.target.value,
                    }))
                  }
                  placeholder={t("agentIdPlaceholder")}
                  className="h-8 font-mono text-[11px]"
                />
                <Input
                  value={newAgent.description}
                  onChange={(event) =>
                    setNewAgent((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder={t("agentDescriptionPlaceholder")}
                  className="h-8 text-[11px]"
                />
                <Input
                  value={newAgent.model}
                  onChange={(event) =>
                    setNewAgent((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  placeholder="deepseek-flash"
                  className="h-8 font-mono text-[11px]"
                />
                <select
                  value={newAgent.role}
                  onChange={(event) =>
                    setNewAgent((current) => ({
                      ...current,
                      role: event.target.value as StudioAgent["role"],
                    }))
                  }
                  aria-label={t("role")}
                  className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 text-[11px] text-zinc-200"
                >
                  <option value="builder">{t("roleBuilder")}</option>
                  <option value="seller">{t("roleSeller")}</option>
                  <option value="specialist">{t("roleSpecialist")}</option>
                </select>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={addAgent}
                  disabled={saving || !newAgent.id || !newAgent.description}
                >
                  {t("createAgent")}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-mono text-sm text-zinc-100">
                  {selected.id}
                </h2>
                <p className="font-mono text-[10px] text-zinc-500">
                  {selected.file}
                </p>
              </div>
              <Button size="sm" onClick={saveAgent} disabled={saving}>
                <Save className="size-3.5" />
                {t("save")}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("agentDescriptionLabel")}>
                <Input
                  value={selected.description}
                  onChange={(event) =>
                    patchAgent({ description: event.target.value })
                  }
                />
              </Field>
              <Field label={t("model")}>
                <Input
                  value={selected.model}
                  onChange={(event) =>
                    patchAgent({ model: event.target.value })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("role")}>
                <select
                  value={selected.role}
                  disabled={selected.isManager}
                  onChange={(event) =>
                    patchAgent({
                      role: event.target.value as StudioAgent["role"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 disabled:opacity-60"
                >
                  <option value="builder">{t("roleBuilder")}</option>
                  <option value="seller">{t("roleSeller")}</option>
                  <option value="specialist">{t("roleSpecialist")}</option>
                  {selected.isManager ? (
                    <option value="manager">{t("roleManager")}</option>
                  ) : null}
                </select>
              </Field>
              <Field label={t("tools")} hint={t("commaHint")}>
                <Input
                  value={selected.tools.join(", ")}
                  onChange={(event) =>
                    patchAgent({ tools: splitList(event.target.value) })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("skills")} hint={t("commaHint")}>
                <Input
                  value={selected.skills.join(", ")}
                  onChange={(event) =>
                    patchAgent({ skills: splitList(event.target.value) })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("filesystem")}>
                <Input
                  value={selected.permissions?.filesystem ?? "readonly"}
                  onChange={(event) =>
                    patchAgent({
                      permissions: {
                        ...selected.permissions,
                        filesystem: event.target.value,
                      },
                    })
                  }
                  className="font-mono"
                />
              </Field>
              <Field label={t("network")}>
                <Input
                  value={selected.permissions?.network ?? "none"}
                  onChange={(event) =>
                    patchAgent({
                      permissions: {
                        ...selected.permissions,
                        network: event.target.value,
                      },
                    })
                  }
                  className="font-mono"
                />
              </Field>
            </div>

            <Field label={t("instructions")}>
              <Textarea
                value={selected.instructions}
                onChange={(event) =>
                  patchAgent({ instructions: event.target.value })
                }
                rows={16}
                className="font-mono text-[11px] leading-relaxed"
              />
            </Field>
            <p className="text-[10px] text-zinc-600">{t("agentHint")}</p>
          </div>
        </div>
      ) : null}

      {tab === "workflows" ? (
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2 rounded-lg border border-border bg-card p-2">
            <div className="flex gap-1">
              <Input
                value={newWorkflowId}
                onChange={(event) => setNewWorkflowId(event.target.value)}
                placeholder={t("workflowId")}
                className="h-8 font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={addWorkflow}
                disabled={workflowBusy || !newWorkflowId.trim()}
                aria-label={t("workflowNew")}
              >
                <Plus className="size-3.5" />
              </Button>
            </div>
            {data.workflows.map((workflow) => (
              <button
                key={workflow.file}
                type="button"
                onClick={() => {
                  setWorkflowFile(workflow.file);
                  setWorkflowRaw(workflow.raw);
                }}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
                  workflow.file === workflowFile && "bg-zinc-900 text-zinc-100",
                )}
              >
                <span className="block font-mono">{workflow.id}</span>
                <span className="block truncate text-[10px] text-zinc-600">
                  {workflow.file}
                </span>
              </button>
            ))}
          </div>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs text-zinc-300">
                {currentWorkflow?.id}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={renameCurrentWorkflow}
                  disabled={!currentWorkflow || workflowBusy}
                >
                  {t("workflowRename")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={deleteCurrentWorkflow}
                  disabled={!currentWorkflow || workflowBusy}
                >
                  {t("workflowDelete")}
                </Button>
                <Button size="sm" onClick={saveWorkflow} disabled={saving}>
                  <Save className="size-3.5" />
                  {t("save")}
                </Button>
              </div>
            </div>
            {currentWorkflow ? (
              <WorkflowGraph
                key={currentWorkflow.file}
                dirName={data.dirName}
                file={currentWorkflow.file}
                stages={currentWorkflow.stages}
                onSaved={(content) => setWorkflowRaw(content)}
              />
            ) : null}
            <Textarea
              value={workflowRaw}
              onChange={(event) => setWorkflowRaw(event.target.value)}
              rows={24}
              className="font-mono text-[11px] leading-relaxed"
            />
            <p className="text-[10px] text-zinc-600">{t("workflowHint")}</p>
          </div>
        </div>
      ) : null}

      {tab === "approvals" ? (
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 size-4 text-emerald-300" />
              <div>
                <h3 className="text-sm font-medium text-zinc-100">
                  {t("policyTitle")}
                </h3>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {t("policyHint")}
                </p>
              </div>
            </div>
            <Textarea
              value={policyIntent}
              onChange={(event) => setPolicyIntent(event.target.value)}
              placeholder={t("policyPlaceholder")}
              className="min-h-16 text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => void generatePolicy()}
                disabled={policyBusy !== null}
              >
                <Sparkles className="size-3.5" />
                {policyBusy === "draft"
                  ? t("policyGenerating")
                  : t("policyGenerate")}
              </Button>
              {policy ? (
                <Button
                  size="sm"
                  onClick={() => void applyPolicy()}
                  disabled={policyBusy !== null}
                >
                  <CheckCircle2 className="size-3.5" />
                  {policyBusy === "apply"
                    ? t("policyApplying")
                    : t("policyApply")}
                </Button>
              ) : null}
              {policy ? (
                <Badge
                  variant={policy.model === "live" ? "success" : "outline"}
                >
                  {policy.model === "live"
                    ? t("policyAi")
                    : t("policyHeuristic")}
                </Badge>
              ) : null}
            </div>
            {policy ? (
              <div className="space-y-2">
                <p className="text-[11px] text-zinc-400">{policy.rationale}</p>
                {policy.warnings.length > 0 ? (
                  <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                    {policy.warnings.map((warning) => (
                      <li key={warning}>· {warning}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="space-y-1">
                  {policy.policies.map((row) => {
                    const key = `${row.file}:${row.stageId}`;
                    const checked = !policyExcluded[key];
                    return (
                      <label
                        key={key}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2.5 py-1.5 text-[10px]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setPolicyExcluded((current) => ({
                              ...current,
                              [key]: checked,
                            }))
                          }
                          className="size-3.5 accent-emerald-500"
                        />
                        <span className="font-mono text-zinc-300">
                          {row.file} · {row.stageId}
                        </span>
                        <span className="ml-auto text-zinc-400">
                          {describePolicy(row.approval, t)}
                        </span>
                        <span className="w-full text-zinc-600">
                          {row.reason}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <details className="rounded-lg border border-border bg-card">
            <summary className="cursor-pointer px-4 py-3 text-xs text-zinc-400">
              {t("policyAdvanced")}
            </summary>
            <div className="space-y-4 px-4 pb-4">
              <p className="rounded-lg border border-border bg-zinc-950/40 px-4 py-3 text-[11px] text-zinc-400">
                {t("approvalIntro")}
              </p>
              {data.workflows.map((workflow) => (
                <div
                  key={workflow.file}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-mono text-xs text-zinc-200">
                      {workflow.id}
                    </h3>
                    <span className="font-mono text-[10px] text-zinc-600">
                      {workflow.file}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {workflow.stages.map((stage) => {
                      const key = `${workflow.file}:${stage.id}`;
                      const draft = approvalDrafts[key] ?? emptyDraft(stage);
                      return (
                        <div
                          key={key}
                          className="grid gap-2 rounded-md border border-border px-3 py-2 lg:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,0.7fr))_auto] lg:items-end"
                        >
                          <div className="flex items-center gap-2">
                            <Lock
                              className={cn(
                                "size-3.5",
                                draft.enabled
                                  ? "text-amber-300"
                                  : "text-zinc-600",
                              )}
                            />
                            <div>
                              <p className="font-mono text-[11px] text-zinc-200">
                                {stage.id}
                              </p>
                              <p className="text-[10px] text-zinc-600">
                                {stage.type}
                                {stage.agent ? ` · ${stage.agent}` : ""}
                              </p>
                            </div>
                          </div>
                          <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                            <input
                              type="checkbox"
                              checked={draft.enabled}
                              onChange={(event) =>
                                updateDraft(key, {
                                  enabled: event.target.checked,
                                })
                              }
                              className="size-3.5 accent-emerald-500"
                            />
                            {t("approvalOn")}
                          </label>
                          <select
                            value={draft.mode}
                            disabled={!draft.enabled}
                            onChange={(event) =>
                              updateDraft(key, {
                                mode: event.target
                                  .value as ApprovalDraft["mode"],
                              })
                            }
                            className="h-7 rounded border border-border bg-zinc-950 px-1.5 text-[10px] text-zinc-300"
                          >
                            <option value="required">
                              {t("modeRequired")}
                            </option>
                            <option value="auto">{t("modeAuto")}</option>
                            <option value="never">{t("modeNever")}</option>
                          </select>
                          <select
                            value={draft.position}
                            disabled={!draft.enabled}
                            onChange={(event) =>
                              updateDraft(key, {
                                position: event.target
                                  .value as ApprovalDraft["position"],
                              })
                            }
                            className="h-7 rounded border border-border bg-zinc-950 px-1.5 text-[10px] text-zinc-300"
                          >
                            <option value="after">{t("positionAfter")}</option>
                            <option value="before">
                              {t("positionBefore")}
                            </option>
                          </select>
                          <select
                            value={draft.riskClass}
                            disabled={!draft.enabled}
                            onChange={(event) =>
                              updateDraft(key, {
                                riskClass: event.target
                                  .value as ApprovalDraft["riskClass"],
                              })
                            }
                            className="h-7 rounded border border-border bg-zinc-950 px-1.5 text-[10px] text-zinc-300"
                          >
                            <option value="low">{t("riskLow")}</option>
                            <option value="medium">{t("riskMedium")}</option>
                            <option value="high">{t("riskHigh")}</option>
                          </select>
                          <div className="flex items-end gap-1.5">
                            <div className="flex-1 text-[10px] text-zinc-500">
                              <span aria-hidden="true">TTL</span>
                              <Input
                                value={draft.ttl}
                                disabled={!draft.enabled}
                                aria-label="TTL"
                                onChange={(event) =>
                                  updateDraft(key, { ttl: event.target.value })
                                }
                                className="mt-0.5 h-7 font-mono text-[10px]"
                              />
                            </div>
                            {draft.mode === "auto" ? (
                              <div className="flex-1 text-[10px] text-zinc-500">
                                <span aria-hidden="true">{t("maxCost")}</span>
                                <Input
                                  value={draft.maxRunCostCny}
                                  disabled={!draft.enabled}
                                  aria-label={t("maxCost")}
                                  onChange={(event) =>
                                    updateDraft(key, {
                                      maxRunCostCny: event.target.value,
                                    })
                                  }
                                  placeholder="0.5"
                                  className="mt-0.5 h-7 font-mono text-[10px]"
                                />
                              </div>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={saving}
                            onClick={() => saveApproval(workflow, stage)}
                          >
                            {t("save")}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      {tab === "autopilot" ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-medium text-zinc-200">
                {t("autopilotTitle")}
              </h3>
              <p className="text-[10px] text-zinc-500">{t("autopilotHint")}</p>
            </div>
            <div className="flex gap-2">
              <Link href="/autopilot">
                <Button size="sm" variant="outline">
                  {t("openAutopilot")}
                </Button>
              </Link>
              <Button size="sm" onClick={saveAutopilot} disabled={saving}>
                <Save className="size-3.5" />
                {t("save")}
              </Button>
            </div>
          </div>
          <Textarea
            value={autopilotRaw}
            onChange={(event) => setAutopilotRaw(event.target.value)}
            rows={20}
            className="font-mono text-[11px] leading-relaxed"
          />
        </div>
      ) : null}
    </div>
  );

  function updateDraft(key: string, patch: Partial<ApprovalDraft>) {
    setApprovalDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {
          enabled: false,
          mode: "required",
          position: "after",
          riskClass: "medium",
          ttl: "72h",
          maxRunCostCny: "",
        }),
        ...patch,
      },
    }));
  }
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <label
      htmlFor={id}
      className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
    >
      <span>
        {label}
        {hint ? (
          <span className="ml-1 normal-case text-zinc-600">{hint}</span>
        ) : null}
      </span>
      {control}
    </label>
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildApprovalDrafts(data: StudioData): Record<string, ApprovalDraft> {
  const drafts: Record<string, ApprovalDraft> = {};
  for (const workflow of data.workflows) {
    for (const stage of workflow.stages) {
      drafts[`${workflow.file}:${stage.id}`] = emptyDraft(stage);
    }
  }
  return drafts;
}

function emptyDraft(stage: StudioStage): ApprovalDraft {
  return {
    enabled: Boolean(stage.approval),
    mode: stage.approval?.mode ?? "required",
    position: stage.approval?.position ?? "after",
    riskClass: stage.approval?.riskClass ?? "medium",
    ttl: stage.approval?.ttl ?? "72h",
    maxRunCostCny:
      stage.approval?.autoApproveWhen?.maxRunCostCny !== undefined
        ? String(stage.approval.autoApproveWhen.maxRunCostCny)
        : "",
  };
}

function draftFromPolicy(row: PolicyRow): ApprovalDraft {
  return {
    enabled: row.approval !== null,
    mode: row.approval?.mode ?? "required",
    position: row.approval?.position ?? "after",
    riskClass: row.approval?.riskClass ?? "medium",
    ttl: row.approval?.ttl ?? "72h",
    maxRunCostCny:
      row.approval?.autoApproveWhen?.maxRunCostCny !== undefined
        ? String(row.approval.autoApproveWhen.maxRunCostCny)
        : "",
  };
}

function describePolicy(
  approval: PolicyApproval | null,
  t: ReturnType<typeof useTranslations>,
): string {
  if (!approval) {
    return t("policyNoGate");
  }
  const position =
    approval.position === "before" ? t("positionBefore") : t("positionAfter");
  const risk =
    approval.riskClass === "high"
      ? t("riskHigh")
      : approval.riskClass === "low"
        ? t("riskLow")
        : t("riskMedium");
  const cap =
    approval.autoApproveWhen?.maxRunCostCny !== undefined
      ? ` ≤ ¥${approval.autoApproveWhen.maxRunCostCny}`
      : "";
  const mode =
    approval.mode === "required"
      ? t("modeRequired")
      : approval.mode === "auto"
        ? `${t("modeAuto")}${cap}`
        : t("modeNever");
  return `${mode} · ${position} · ${risk} · ${approval.ttl}`;
}
