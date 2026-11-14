export * from "./pack-types";
export * from "./temporal-client";

export type StageKind = "workflow" | "agent";

export interface RetryPolicy {
  max: number;
  backoff: "fixed" | "exp";
}

export interface StageDefinition {
  id: string;
  type: StageKind;
  agent?: string;
  inputs: string[];
  outputs: string[];
  timeout?: string;
  retry?: RetryPolicy;
  gate?: string;
}

export interface DeliveryDefinition {
  channel: "im" | "email" | "local_file";
  approval?: "never" | "required_if_published";
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  trigger: {
    event: string;
    schedule?: string;
  };
  stages: StageDefinition[];
  delivery?: DeliveryDefinition;
}
