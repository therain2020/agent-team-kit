export * from "./pack-types";
export * from "./iteration-types";
export * from "./temporal-client";

export type StageKind = "workflow" | "agent" | "coder";

export interface RetryPolicy {
  max: number;
  backoff: "fixed" | "exp";
}

export interface StageDefinition {
  id: string;
  type: StageKind;
  agent?: string;
  coder?: string;
  goal?: string;
  acceptance?: string;
  inputs: string[];
  outputs: string[];
  timeout?: string;
  retry?: RetryPolicy;
  gate?: string;
  inputFrom?: string;
  inputsFrom?: string[];
  position?: { x: number; y: number };
}

export interface DeliveryDefinition {
  channel: "im" | "email" | "local_file" | "webhook";
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
