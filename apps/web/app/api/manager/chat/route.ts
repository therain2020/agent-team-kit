import { buildChatContext, publishManagerExchange } from "@/lib/manager";
import {
  checkManagerBudget,
  recordManagerRejection,
} from "@/lib/manager-budget";
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
  let body: { messages?: UIMessage[]; runId?: string };
  try {
    body = (await request.json()) as {
      messages?: UIMessage[];
      runId?: string;
    };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body.runId || typeof body.runId !== "string") {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
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

  const store = await getStore();
  const run = await store.runs.get(body.runId);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const budget = await checkManagerBudget({
    workspaceId: run.workspaceId,
    sessionId: run.runId,
    store,
  });
  if (!budget.allowed) {
    await recordManagerRejection({
      workspaceId: run.workspaceId,
      sessionId: run.runId,
      runId: run.runId,
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

  const { system, brief } = await buildChatContext(body.runId, store);
  const question = lastUserText(body.messages) || "Summarize this run.";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const stub = process.env.KIT_MODEL_MODE === "stub" || !apiKey;

  if (stub) {
    const answer = stubAnswer(question, brief);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const id = "manager-stub";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: answer });
        writer.write({ type: "text-end", id });
        try {
          await publishManagerExchange({
            runId: run.runId,
            workspaceId: run.workspaceId,
            question,
            answer,
            model: "stub",
            inputTokens: 0,
            outputTokens: 0,
            store,
          });
        } catch (error) {
          console.error("failed to publish manager exchange", error);
        }
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
    system,
    messages: await convertToModelMessages(body.messages),
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    onFinish: async ({ text, usage }) => {
      try {
        await publishManagerExchange({
          runId: run.runId,
          workspaceId: run.workspaceId,
          question,
          answer: text,
          model: MODEL_ALIAS,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          store,
        });
      } catch (error) {
        console.error("failed to publish manager exchange", error);
      }
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

function stubAnswer(
  question: string,
  brief: Awaited<ReturnType<typeof buildChatContext>>["brief"],
): string {
  const failed = brief.gates.filter((gate) => !gate.pass);
  const lines = [
    "**Manager (stub mode)**",
    "",
    `Run \`${brief.run.runId}\` is **${brief.run.status}** (${brief.run.runMode}).`,
    `Workflow: \`${brief.run.workflowId}\` · stages: ${brief.stages.length} · artifacts: ${brief.artifacts.length}.`,
    `Cost so far: **${brief.totals.costCny.toFixed(4)} CNY** · ${brief.totals.tokens} tokens.`,
    failed.length > 0
      ? `Failed gate attempts: ${failed.length}. Latest: ${failed.at(-1)?.rationale || "no rationale"}.`
      : "All recorded gate attempts passed.",
    "",
    `Your question: “${question}”`,
    "",
    "Set `DEEPSEEK_API_KEY` (and unset `KIT_MODEL_MODE=stub`) for a live Manager answer. This stub response is published as a `manager-exchange` artifact.",
  ];
  return lines.join("\n");
}
