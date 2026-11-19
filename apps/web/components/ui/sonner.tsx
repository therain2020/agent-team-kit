"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-none !border-px-line2 !bg-px-panel !text-px-text !font-mono !shadow-px",
          description: "!text-px-muted",
          actionButton:
            "!rounded-none !border !border-px-accent-hi !bg-px-accent !font-mono !text-px-accent-ink",
        },
      }}
    />
  );
}
