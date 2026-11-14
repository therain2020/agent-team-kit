import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TelemetryConfig {
  serviceName: string;
  otlpEndpoint?: string;
}

let sdk: NodeSDK | undefined;

export function initTelemetry(config: TelemetryConfig): void {
  if (sdk) {
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: config.otlpEndpoint ?? "http://localhost:4317",
  });

  sdk = new NodeSDK({
    resource: new Resource({ "service.name": config.serviceName }),
    traceExporter: exporter,
  });

  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
