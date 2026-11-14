"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useAISDKChat,
  useAISDKError,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { UIMessage } from "ai";
import { ArrowUp, Loader2, ShieldCheck, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import remarkGfm from "remark-gfm";

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="prose-kit"
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        img: ({ src, alt }) => {
          if (typeof src !== "string") {
            return <span>{alt ?? "image"}</span>;
          }
          return (
            <a href={src} target="_blank" rel="noreferrer noopener">
              {alt || src}
            </a>
          );
        },
      }}
    />
  );
}

function ChatMessage() {
  return (
    <MessagePrimitive.Root className="group py-2">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-zinc-100">
          <MessagePrimitive.Parts />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="max-w-[92%] rounded-lg rounded-bl-sm border border-border bg-card px-3.5 py-2.5">
          <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

export function ManagerChat({
  runId,
  initialMessages,
  stubMode,
}: {
  runId: string;
  initialMessages: UIMessage[];
  stubMode: boolean;
}) {
  const t = useTranslations("managerChat");
  const suggestions = [
    t("suggestionWhyGate"),
    t("suggestionSummarize"),
    t("suggestionChanged"),
    t("suggestionNext"),
  ];
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/manager/chat",
        body: { runId },
      }),
    [runId],
  );

  const runtime = useChatRuntime({
    transport,
    messages: initialMessages,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Badge variant={stubMode ? "warning" : "success"}>
            {stubMode ? t("stub") : t("live")}
          </Badge>
          <span className="text-[11px] text-zinc-500">{t("advisory")}</span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-600">
            <ShieldCheck className="size-3" />
            {t("context", { runId })}
          </span>
        </div>

        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Empty>
            <div className="mx-auto max-w-lg py-10 text-center">
              <p className="text-sm font-medium text-zinc-200">
                {t("emptyTitle")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("emptyDesc")}
              </p>
              <div className="mt-5 grid gap-1.5 text-left">
                {suggestions.map((suggestion) => (
                  <SuggestionButton key={suggestion} text={suggestion} />
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {() => <ChatMessage />}
          </ThreadPrimitive.Messages>
          <ChatError />
        </ThreadPrimitive.Viewport>

        <div className="border-t border-border p-3">
          <ComposerPrimitive.Root className="rounded-lg border border-border bg-zinc-950/60 p-2 focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20">
            <ComposerPrimitive.Input
              placeholder={t("placeholder")}
              submitMode="enter"
              className="max-h-36 min-h-10 w-full resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-zinc-600"
              rows={1}
            />
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-[10px] text-zinc-600">
                {t("outputCap")}
              </span>
              <div className="flex items-center gap-1">
                <RunningIndicator />
                <ComposerPrimitive.Send asChild>
                  <Button size="icon" className="size-7 rounded-md">
                    <ArrowUp className="size-4" />
                    <span className="sr-only">{t("send")}</span>
                  </Button>
                </ComposerPrimitive.Send>
                <ComposerPrimitive.Cancel asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-7 rounded-md"
                  >
                    <Square className="size-3" />
                    <span className="sr-only">{t("stop")}</span>
                  </Button>
                </ComposerPrimitive.Cancel>
              </div>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function SuggestionButton({ text }: { text: string }) {
  const chat = useAISDKChat();

  return (
    <button
      type="button"
      disabled={
        !chat || chat.status === "streaming" || chat.status === "submitted"
      }
      onClick={() => {
        void chat?.sendMessage({ text });
      }}
      className={cn(
        "rounded-md border border-border px-3 py-2 text-left text-xs text-zinc-400 transition-colors hover:bg-accent hover:text-zinc-200 disabled:opacity-50",
      )}
    >
      {text}
    </button>
  );
}

function RunningIndicator() {
  const chat = useAISDKChat();
  if (chat?.status !== "streaming" && chat?.status !== "submitted") {
    return null;
  }
  return <Loader2 className="mr-1 size-3.5 animate-spin text-zinc-500" />;
}

function ChatError() {
  const error = useAISDKError();
  if (!error) {
    return null;
  }
  return (
    <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      {error.message}
    </div>
  );
}
