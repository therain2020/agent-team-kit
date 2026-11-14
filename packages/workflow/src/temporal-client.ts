import { Client, Connection } from "@temporalio/client";

export const temporalAddress =
  process.env.KIT_TEMPORAL_ADDRESS ?? "localhost:7233";
export const temporalNamespace =
  process.env.KIT_TEMPORAL_NAMESPACE ?? "default";
export const taskQueue = process.env.KIT_TASK_QUEUE ?? "kit-demo";

export async function createTemporalClient(): Promise<{
  client: Client;
  connection: Connection;
}> {
  const connection = await Connection.connect({ address: temporalAddress });
  const client = new Client({
    connection,
    namespace: temporalNamespace,
  });

  return { client, connection };
}
