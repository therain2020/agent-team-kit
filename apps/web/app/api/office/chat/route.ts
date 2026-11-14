import { publishManagerExchange } from "@/lib/manager";
import {
  checkManagerBudget,
  recordManagerRejection,
} from "@/lib/manager-budget";
import { buildOfficeChatContext } from "@/lib/office-chat";
import { getStore } from "@/lib/store";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type UIMessage,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from "ai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_OUTPUT_TOKENS = 1200;
const MODEL_ALIAS = "deepseek-pro";

export async function POST(request: Request) {
  let body: { messages?: UIMessage[]; packDir?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.packDir || typeof body.packDir !== "string") {
    return NextResponse.json({ error: "packDir is required" }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: "messages are required" },
      { status: 400 },
    );
  }
  if (body.messages.length > 40) {
    return NextResponse.json({ error: "too many messages" }, { status: 400 });
  }

  let context: Awaited<ReturnType<typeof buildOfficeChatContext>>;
  try {
    context = await buildOfficeChatContext(body.packDir);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "pack not found" },
      { status: 404 },
    );
  }

  const question = lastUserText(body.messages) || "Give me a status overview.";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const stub = process.env.KIT_MODEL_MODE === "stub" || !apiKey;
  const store = await getStore();

  const budget = await checkManagerBudget({
    workspaceId: "default",
    sessionId: context.threadId,
    store,
  });
  if (!budget.allowed) {
    await recordManagerRejection({
      workspaceId: "default",
      sessionId: context.threadId,
      runId: context.threadId,
      reason: budget.reason,
      store,
    });
    return NextResponse.json(
      {
        error: budget.message,
        code: "manager_budget_exceeded",
        reason: budget.reason,
        windowEndsAt: budget.snapshot.windowEndsAt,
        retryAfterSeconds: Math.ceil(budget.snapshot.remainingMs / 1000),
      },
      { status: 429, headers: { "x-kit-budget-reason": budget.reason } },
    );
  }

  if (stub) {
    const answer = `**Manager (stub mode)**\n\nThe team **${context.packName}** is ready. Ask about agents, missions, or approvals. Set \`DEEPSEEK_API_KEY\` for a live answer. Your question: “${question}”`;
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const id = "office-stub";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: answer });
        writer.write({ type: "text-end", id });
        await publishManagerExchange({
          runId: context.threadId,
          workspaceId: "default",
          question,
          answer,
          model: "stub",
          inputTokens: 0,
          outputTokens: 0,
          store,
        }).catch(() => undefined);
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey,
  });
  const modelId = process.env.DEEPSEEK_MODEL_PRO ?? "deepseek-v4-pro";

  const result = streamText({
    model: provider.chatModel(modelId),
    system: context.system,
    messages: await convertToModelMessages(body.messages),
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    onFinish: async ({ text, usage }) => {
      await publishManagerExchange({
        runId: context.threadId,
        workspaceId: "default",
        question,
        answer: text,
        model: MODEL_ALIAS,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        store,
      }).catch(() => undefined);
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) =>
      error instanceof Error ? error.message : "manager stream failed",
  });
}

function lastUserText(messages: UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    return message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}
