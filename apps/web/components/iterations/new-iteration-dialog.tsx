"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const DOMAINS = ["", "cyber", "ux", "perf", "docs"];

export function NewIterationDialog({
  defaultOpen = false,
  triggerLabel = "New iteration",
}: {
  defaultOpen?: boolean;
  triggerLabel?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [pack, setPack] = useState("self-improve");
  const [domain, setDomain] = useState("");
  const [maxTasks, setMaxTasks] = useState("2");
  const [applyMode, setApplyMode] = useState<"none" | "low" | "low-medium">(
    "low",
  );
  const [live, setLive] = useState(false);
  const [stub, setStub] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    if (!goal.trim()) {
      setError("A goal is required.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "iteration",
          packDir: pack.trim(),
          goal,
          ...(acceptance.trim() ? { acceptance } : {}),
          ...(domain ? { domain } : {}),
          maxTasks: Number(maxTasks) || 2,
          runMode: live ? "LIVE" : "DRY_RUN",
          ...(live ? { applyMode } : {}),
          stub,
        }),
      });
      const payload = (await response.json()) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !payload.jobId) {
        setError(payload.error ?? `HTTP ${response.status}`);
        return;
      }
      toast.success(`Iteration ${payload.jobId} started`);
      setOpen(false);
      router.push(`/iterations/${encodeURIComponent(payload.jobId)}`);
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : "failed to start",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Play className="size-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New iteration</DialogTitle>
          <DialogDescription>
            Plan tasks, delegate to an external coder, verify and apply. DRY_RUN
            is the default; LIVE requires KIT_UI_ALLOW_LIVE=1.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="iteration-goal"
              className="text-xs font-medium text-zinc-300"
            >
              Goal
            </label>
            <Textarea
              id="iteration-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Find one security weakness and one UX problem, fix them, verify."
              className="min-h-20 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="iteration-acceptance"
              className="text-xs font-medium text-zinc-300"
            >
              Acceptance (optional)
            </label>
            <Textarea
              id="iteration-acceptance"
              value={acceptance}
              onChange={(event) => setAcceptance(event.target.value)}
              placeholder="Small verified changes; high-risk changes stay pending."
              className="min-h-16 text-xs"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="iteration-pack"
                className="text-xs font-medium text-zinc-300"
              >
                Pack
              </label>
              <Input
                id="iteration-pack"
                value={pack}
                onChange={(event) => setPack(event.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="iteration-domain"
                className="text-xs font-medium text-zinc-300"
              >
                Domain
              </label>
              <select
                id="iteration-domain"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
              >
                {DOMAINS.map((item) => (
                  <option key={item || "all"} value={item}>
                    {item || "planner decides"}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="iteration-max-tasks"
                className="text-xs font-medium text-zinc-300"
              >
                Max tasks
              </label>
              <Input
                id="iteration-max-tasks"
                type="number"
                min={1}
                max={20}
                value={maxTasks}
                onChange={(event) => setMaxTasks(event.target.value)}
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="iteration-apply"
                className="text-xs font-medium text-zinc-300"
              >
                Auto-apply (LIVE only)
              </label>
              <select
                id="iteration-apply"
                value={applyMode}
                onChange={(event) =>
                  setApplyMode(
                    event.target.value as "none" | "low" | "low-medium",
                  )
                }
                className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-ring"
              >
                <option value="none">none</option>
                <option value="low">low</option>
                <option value="low-medium">low-medium</option>
              </select>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={live}
                onChange={(event) => setLive(event.target.checked)}
                className="mt-0.5 size-3.5 accent-emerald-500"
              />
              <span>
                <span className="block text-xs font-medium text-zinc-300">
                  LIVE
                </span>
                <span className="block text-[10px] text-zinc-500">
                  Writes commits when auto-apply allows it.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={stub}
                onChange={(event) => setStub(event.target.checked)}
                className="mt-0.5 size-3.5 accent-emerald-500"
              />
              <span>
                <span className="block text-xs font-medium text-zinc-300">
                  Stub planner
                </span>
                <span className="block text-[10px] text-zinc-500">
                  Deterministic plan; the coder still runs.
                </span>
              </span>
            </label>
          </div>

          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => void start()} disabled={pending}>
            {pending ? "Starting…" : "Start iteration"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
