"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!border-zinc-800 !bg-zinc-900 !text-zinc-100 !shadow-xl",
          description: "!text-zinc-400",
          actionButton: "!bg-emerald-500 !text-zinc-950",
        },
      }}
    />
  );
}
