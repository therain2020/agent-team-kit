"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Bot, Plus, Rocket, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type Template = "minimal" | "research" | "content" | "product";
type Role = "builder" | "seller" | "specialist";

interface Employee {
  id: string;
  description: string;
  model: string;
  role: Role;
}

const TEMPLATES: Record<
  Template,
  { label: string; hint: string; employees: Employee[] }
> = {
  minimal: {
    label: "Minimal",
    hint: "One worker, one stage. Fastest way to see a run.",
    employees: [
      {
        id: "worker",
        description: "Completes the assigned task",
        model: "deepseek-flash",
        role: "builder",
      },
    ],
  },
  research: {
    label: "Research",
    hint: "Researcher → writer → reviewer. Evidence-first.",
    employees: [
      {
        id: "researcher",
        description: "Collects and verifies source evidence",
        model: "deepseek-flash",
        role: "builder",
      },
      {
        id: "writer",
        description: "Turns evidence into a structured brief",
        model: "deepseek-pro",
        role: "builder",
      },
      {
        id: "reviewer",
        description: "Checks citations and actionability",
        model: "deepseek-pro",
        role: "specialist",
      },
    ],
  },
  content: {
    label: "Content",
    hint: "Seller → builder → editor. Human-sounding output.",
    employees: [
      {
        id: "planner",
        description: "Clarifies audience, angle, and acceptance",
        model: "deepseek-flash",
        role: "seller",
      },
      {
        id: "writer",
        description: "Writes the primary content",
        model: "deepseek-pro",
        role: "builder",
      },
      {
        id: "editor",
        description: "Edits for clarity and accuracy",
        model: "deepseek-pro",
        role: "specialist",
      },
    ],
  },
  product: {
    label: "Product",
    hint: "Seller → builder → verifier → seller package. Task-centric.",
    employees: [
      {
        id: "seller",
        description: "Owns requirements, acceptance, and delivery",
        model: "deepseek-pro",
        role: "seller",
      },
      {
        id: "builder",
        description: "Builds and optimizes the project",
        model: "deepseek-pro",
        role: "builder",
      },
      {
        id: "verifier",
        description: "Independently verifies the build",
        model: "deepseek-pro",
        role: "specialist",
      },
    ],
  },
};

export function NewPackWizard() {
  const t = useTranslations("newPack");
  const router = useRouter();
  const [template, setTemplate] = useState<Template>("research");
  const [name, setName] = useState("my-team");
  const [dirName, setDirName] = useState("my-team");
  const [description, setDescription] = useState("");
  const [managerName, setManagerName] = useState("manager");
  const [managerModel, setManagerModel] = useState("deepseek-pro");
  const [managerInstructions, setManagerInstructions] = useState("");
  const [employees, setEmployees] = useState<Employee[]>(
    TEMPLATES.research.employees,
  );
  const [pending, setPending] = useState(false);

  const slug = useMemo(
    () =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "my-team",
    [name],
  );

  function chooseTemplate(value: Template) {
    setTemplate(value);
    setEmployees(TEMPLATES[value].employees.map((item) => ({ ...item })));
  }

  function patchEmployee(index: number, patch: Partial<Employee>) {
    setEmployees((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  }

  async function create() {
    setPending(true);
    try {
      const response = await fetch("/api/packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dirName: dirName || slug,
          name,
          description,
          template,
          managerName,
          managerModel,
          managerInstructions,
          agents: employees,
        }),
      });
      const payload = (await response.json()) as {
        dirName?: string;
        error?: string;
      };
      if (!response.ok || !payload.dirName) {
        throw new Error(payload.error ?? t("failed"));
      }
      toast.success(t("created"));
      router.push(`/packs/${encodeURIComponent(payload.dirName)}/studio`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <div className="space-y-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Users className="size-4 text-emerald-400" />
            {t("template")}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {(Object.keys(TEMPLATES) as Template[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseTemplate(value)}
                className={cn(
                  "rounded-lg border border-border p-3 text-left transition-colors hover:border-zinc-600",
                  template === value &&
                    "border-emerald-500/50 bg-emerald-500/5",
                )}
              >
                <p className="text-xs font-medium text-zinc-200">
                  {TEMPLATES[value].label}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                  {TEMPLATES[value].hint}
                </p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Bot className="size-4 text-violet-400" />
            {t("identity")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label
              htmlFor="new-team-name"
              className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("teamName")}
              <Input
                id="new-team-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label
              htmlFor="new-team-dir"
              className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("directory")}
              <Input
                id="new-team-dir"
                value={dirName}
                onChange={(event) => setDirName(event.target.value)}
                placeholder={slug}
                className="font-mono"
              />
            </label>
            <label
              htmlFor="new-team-description"
              className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500 sm:col-span-2"
            >
              {t("descriptionLabel")}
              <Input
                id="new-team-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
              <Users className="size-4 text-sky-400" />
              {t("employees")}
            </h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setEmployees((current) => [
                  ...current,
                  {
                    id: `worker-${current.length + 1}`,
                    description: "Team member",
                    model: "deepseek-flash",
                    role: "builder",
                  },
                ])
              }
            >
              <Plus className="size-3.5" />
              {t("addEmployee")}
            </Button>
          </div>
          <div className="space-y-2">
            {employees.map((employee, index) => (
              <div
                key={`${employee.id}-${index}`}
                className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[8rem_minmax(0,1fr)_7rem_8rem_auto]"
              >
                <Input
                  value={employee.id}
                  onChange={(event) =>
                    patchEmployee(index, { id: event.target.value })
                  }
                  className="h-8 font-mono text-[11px]"
                />
                <Input
                  value={employee.description}
                  onChange={(event) =>
                    patchEmployee(index, { description: event.target.value })
                  }
                  className="h-8 text-[11px]"
                />
                <Input
                  value={employee.model}
                  onChange={(event) =>
                    patchEmployee(index, { model: event.target.value })
                  }
                  className="h-8 font-mono text-[11px]"
                />
                <select
                  value={employee.role}
                  onChange={(event) =>
                    patchEmployee(index, {
                      role: event.target.value as Role,
                    })
                  }
                  aria-label={t("role")}
                  className="h-8 rounded-md border border-border bg-zinc-950 px-1.5 text-[11px] text-zinc-200"
                >
                  <option value="builder">{t("roleBuilder")}</option>
                  <option value="seller">{t("roleSeller")}</option>
                  <option value="specialist">{t("roleSpecialist")}</option>
                </select>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={employees.length <= 1}
                  onClick={() =>
                    setEmployees((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="space-y-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-200">
            {t("manager")}
          </h2>
          <div className="space-y-3">
            <label
              htmlFor="new-manager-name"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("managerName")}
              <Input
                id="new-manager-name"
                value={managerName}
                onChange={(event) => setManagerName(event.target.value)}
              />
            </label>
            <label
              htmlFor="new-manager-model"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("model")}
              <Input
                id="new-manager-model"
                value={managerModel}
                onChange={(event) => setManagerModel(event.target.value)}
                className="font-mono"
              />
            </label>
            <label
              htmlFor="new-manager-instructions"
              className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
            >
              {t("managerInstructions")}
              <Textarea
                id="new-manager-instructions"
                value={managerInstructions}
                onChange={(event) => setManagerInstructions(event.target.value)}
                rows={7}
                placeholder={t("managerPlaceholder")}
                className="text-[11px] leading-relaxed"
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Rocket className="size-4 text-amber-300" />
            {t("whatYouGet")}
          </h2>
          <ul className="space-y-1 text-[11px] text-zinc-400">
            <li>• {t("getFiles")}</li>
            <li>• {t("getApproval")}</li>
            <li>• {t("getAutopilot")}</li>
            <li>• {t("getStudio")}</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge variant="outline">{template}</Badge>
            <Badge variant="outline">{employees.length} agents</Badge>
            <Badge variant="outline">manager/manager.md</Badge>
          </div>
          <Button
            className="mt-4 w-full"
            onClick={create}
            disabled={pending || !name.trim() || !dirName.trim()}
          >
            {pending ? t("creating") : t("create")}
          </Button>
          <p className="mt-2 text-center text-[10px] text-zinc-600">
            {t("footer")}
          </p>
        </section>
      </div>
    </div>
  );
}
