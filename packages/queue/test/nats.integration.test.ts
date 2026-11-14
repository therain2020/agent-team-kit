import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NatsEventQueue } from "../src/index";

const enabled = process.env.KIT_INTEGRATION === "1";
const runId = Date.now().toString();
const stream = `KIT_TEST_${runId}`;
const subjectPrefix = `kit.test.${runId}`;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for messages");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!enabled)("nats queue integration", () => {
  let queue: NatsEventQueue;

  beforeAll(async () => {
    queue = new NatsEventQueue({
      url: process.env.KIT_NATS_URL ?? "nats://localhost:4222",
      stream,
      subjects: [`${subjectPrefix}.>`],
    });
    await queue.connect();
  });

  afterAll(async () => {
    await queue.destroy();
  });

  it("dedupes publishes with the same message id", async () => {
    const subject = `${subjectPrefix}.dedupe`;
    const payload = new TextEncoder().encode(JSON.stringify({ n: 1 }));
    const received: string[] = [];
    const stop = await queue.subscribe(subject, async (message) => {
      received.push(message.subject);
    });

    await queue.publish(subject, payload, "msg-1");
    await queue.publish(subject, payload, "msg-1");
    await waitFor(() => received.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await stop();
    expect(received).toHaveLength(1);
  });

  it("delivers distinct message ids", async () => {
    const subject = `${subjectPrefix}.distinct`;
    const received: string[] = [];
    const stop = await queue.subscribe(subject, async (message) => {
      received.push(message.subject);
    });

    await queue.publish(subject, new TextEncoder().encode("a"), "msg-a");
    await queue.publish(subject, new TextEncoder().encode("b"), "msg-b");
    await waitFor(() => received.length >= 2);

    await stop();
    expect(received).toHaveLength(2);
  });
});
