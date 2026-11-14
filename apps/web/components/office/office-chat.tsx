"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ArrowUp, ShieldCheck, Square } from "lucide-react";
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
      }}
    />
  );
}

function ChatMessage() {
  return (
    <MessagePrimitive.Root className="py-1.5">
      <MessagePrimitive.If user>
        <div className="ml-auto max-w-[88%] rounded-lg rounded-br-sm border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[13px] text-zinc-100">
          <MessagePrimitive.Parts />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="max-w-[94%] rounded-lg rounded-bl-sm border border-border bg-zinc-950/50 px-3 py-2 text-[13px]">
          <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

export function OfficeChat({
  packDir,
  initialMessages,
  stubMode,
  onClose,
}: {
  packDir: string;
  initialMessages: UIMessage[];
  stubMode: boolean;
  onClose?: () => void;
}) {
  const t = useTranslations("officeChat");
  const suggestions = [
    t("suggestionStatus"),
    t("suggestionAgents"),
    t("suggestionBlocked"),
    t("suggestionNext"),
  ];
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/office/chat",
        body: { packDir },
      }),
    [packDir],
  );
  const runtime = useChatRuntime({
    transport,
    messages: initialMessages,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Badge variant={stubMode ? "warning" : "success"}>
            {stubMode ? t("stub") : t("live")}
          </Badge>
          <span className="truncate text-[10px] text-zinc-500">
            {t("context")}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[9px] text-zinc-600">
            <ShieldCheck className="size-3" />
            {t("advisory")}
          </span>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="text-[10px] text-zinc-500 hover:text-zinc-200"
            >
              {t("close")}
            </button>
          ) : null}
        </div>

        <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ThreadPrimitive.Empty>
            <div className="py-6 text-center">
              <p className="text-xs font-medium text-zinc-200">
                {t("emptyTitle")}
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                {t("emptyDesc")}
              </p>
              <div className="mt-3 grid gap-1">
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

        <div className="border-t border-border p-2">
          <ComposerPrimitive.Root className="rounded-lg border border-border bg-zinc-950/60 p-1.5 focus-within:border-ring/60">
            <ComposerPrimitive.Input
              placeholder={t("placeholder")}
              submitMode="enter"
              className="max-h-24 min-h-8 w-full resize-none bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-zinc-600"
              rows={1}
            />
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] text-zinc-600">{t("hint")}</span>
              <div className="flex items-center gap-1">
                <RunningIndicator />
                <ComposerPrimitive.Send asChild>
                  <Button size="icon" className="size-6 rounded-md">
                    <ArrowUp className="size-3.5" />
                    <span className="sr-only">{t("send")}</span>
                  </Button>
                </ComposerPrimitive.Send>
                <ComposerPrimitive.Cancel asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-6 rounded-md"
                  >
                    <Square className="size-2.5" />
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
  const disabled =
    !chat || chat.status === "streaming" || chat.status === "submitted";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => chat?.sendMessage({ text })}
      className="rounded border border-border px-2 py-1.5 text-left text-[10px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
    >
      {text}
    </button>
  );
}

function RunningIndicator() {
  const chat = useAISDKChat();
  if (!chat || (chat.status !== "streaming" && chat.status !== "submitted")) {
    return null;
  }
  return (
    <span className="mr-1 flex items-center gap-1 text-[9px] text-zinc-500">
      <span className="size-1 animate-pulse rounded-full bg-emerald-400" />
    </span>
  );
}

function ChatError() {
  const error = useAISDKError();
  if (!error) {
    return null;
  }
  return (
    <p className="mt-2 rounded border border-red-500/20 bg-red-500/5 px-2 py-1 text-[10px] text-red-300">
      {error.message}
    </p>
  );
}
