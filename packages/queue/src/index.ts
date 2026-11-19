import {
  AckPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
  connect,
} from "nats";

export * from "./spool";

export interface QueueMessage {
  subject: string;
  data: Uint8Array;
}

export interface EventQueue {
  publish(subject: string, data: Uint8Array, messageId?: string): Promise<void>;
  subscribe(
    subject: string,
    handler: (message: QueueMessage) => Promise<void>,
  ): Promise<() => Promise<void>>;
}

export interface NatsQueueOptions {
  url: string;
  stream: string;
  subjects: string[];
  durable?: string;
}

export class NatsEventQueue implements EventQueue {
  private connection?: NatsConnection;
  private jetstream?: JetStreamClient;
  private manager?: JetStreamManager;
  private readonly stops = new Set<() => Promise<void>>();

  constructor(private readonly options: NatsQueueOptions) {}

  async connect(): Promise<void> {
    this.connection = await connect({ servers: this.options.url });
    this.manager = await this.connection.jetstreamManager();
    this.jetstream = this.connection.jetstream();
    await this.ensureStream();
  }

  private async ensureStream(): Promise<void> {
    if (!this.manager) {
      throw new Error("queue not connected");
    }

    try {
      await this.manager.streams.info(this.options.stream);
    } catch {
      await this.manager.streams.add({
        name: this.options.stream,
        subjects: this.options.subjects,
      });
    }
  }

  private async ensureConsumer(
    durable: string,
    subject: string,
  ): Promise<void> {
    if (!this.manager) {
      throw new Error("queue not connected");
    }

    try {
      await this.manager.consumers.info(this.options.stream, durable);
      return;
    } catch {
      await this.manager.consumers.add(this.options.stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        filter_subject: subject,
      });
    }
  }

  async publish(
    subject: string,
    data: Uint8Array,
    messageId?: string,
  ): Promise<void> {
    if (!this.jetstream) {
      throw new Error("queue not connected");
    }

    if (messageId) {
      await this.jetstream.publish(subject, data, { msgID: messageId });
      return;
    }

    await this.jetstream.publish(subject, data);
  }

  async subscribe(
    subject: string,
    handler: (message: QueueMessage) => Promise<void>,
  ): Promise<() => Promise<void>> {
    if (!this.jetstream) {
      throw new Error("queue not connected");
    }

    const durable =
      this.options.durable ??
      `${this.options.stream}_${subject.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    await this.ensureConsumer(durable, subject);

    const consumer = await this.jetstream.consumers.get(
      this.options.stream,
      durable,
    );

    let stopped = false;
    const loopPromise = (async () => {
      while (!stopped) {
        let messages: Awaited<ReturnType<typeof consumer.fetch>>;
        try {
          messages = await consumer.fetch({
            max_messages: 10,
            expires: 1000,
          });
        } catch {
          if (stopped) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }

        try {
          for await (const message of messages) {
            try {
              await handler({ subject: message.subject, data: message.data });
              message.ack();
            } catch {
              message.nak(5000);
            }
          }
        } finally {
          await messages.close();
        }
      }
    })();

    const stop = async () => {
      stopped = true;
      await loopPromise.catch(() => {});
      this.stops.delete(stop);
    };

    this.stops.add(stop);
    return stop;
  }

  async close(): Promise<void> {
    for (const stop of [...this.stops]) {
      await stop();
    }
    await this.connection?.drain();
    this.connection = undefined;
    this.jetstream = undefined;
    this.manager = undefined;
  }

  async destroy(): Promise<void> {
    for (const stop of [...this.stops]) {
      await stop();
    }
    if (this.manager) {
      try {
        await this.manager.streams.delete(this.options.stream);
      } catch {
        // stream may already be gone
      }
    }
    await this.close();
  }
}
