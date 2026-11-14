"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";
import { useState } from "react";

export interface TokenOption {
  value: string;
  description?: string;
}

export function TokenPicker({
  values,
  options,
  onChange,
  selectLabel,
  customPlaceholder,
  addLabel,
  unknownLabel,
}: {
  values: string[];
  options: TokenOption[];
  onChange: (next: string[]) => void;
  selectLabel: string;
  customPlaceholder: string;
  addLabel: string;
  unknownLabel: string;
}) {
  const [custom, setCustom] = useState("");
  const known = new Set(options.map((option) => option.value));
  const available = options.filter((option) => !values.includes(option.value));

  function add(value: string) {
    const next = value.trim();
    if (!next || values.includes(next)) {
      return;
    }
    onChange([...values, next]);
  }

  function remove(value: string) {
    onChange(values.filter((item) => item !== value));
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {values.length === 0 ? (
          <span className="text-[10px] text-zinc-600">—</span>
        ) : (
          values.map((value) => (
            <span
              key={value}
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                known.has(value)
                  ? "border-zinc-700 bg-zinc-900 text-zinc-300"
                  : "border-red-500/40 bg-red-500/5 text-red-300",
              )}
              title={known.has(value) ? undefined : unknownLabel}
            >
              {value}
              <button
                type="button"
                onClick={() => remove(value)}
                aria-label={`remove ${value}`}
                className="text-zinc-500 hover:text-zinc-200"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))
        )}
      </div>
      <select
        value=""
        onChange={(event) => add(event.target.value)}
        aria-label={selectLabel}
        className="h-8 w-full rounded-md border border-border bg-zinc-950 px-2 text-[11px] text-zinc-200"
      >
        <option value="">{selectLabel}</option>
        {available.map((option) => (
          <option key={option.value} value={option.value}>
            {option.description
              ? `${option.value} — ${option.description}`
              : option.value}
          </option>
        ))}
      </select>
      <div className="flex gap-1">
        <Input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(custom);
              setCustom("");
            }
          }}
          placeholder={customPlaceholder}
          className="h-8 font-mono text-[11px]"
        />
        <button
          type="button"
          onClick={() => {
            add(custom);
            setCustom("");
          }}
          aria-label={addLabel}
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-zinc-400 hover:text-zinc-100"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
