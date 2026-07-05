import { type Tracer, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { WardenConfig } from "./config.js";

export const TRACER_NAME = "warden-gateway";

/** Returns the gateway tracer; a no-op tracer unless a provider was started. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Starts the OTel NodeSDK with an OTLP/HTTP trace exporter when an endpoint
 * is configured (config or OTEL_EXPORTER_OTLP_ENDPOINT). Returns a shutdown
 * hook, or undefined when tracing is disabled — in that case all spans are
 * no-ops with zero overhead.
 */
export function startTelemetry(config: WardenConfig): (() => Promise<void>) | undefined {
  const endpoint =
    config.observability?.otlpEndpoint ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }

  const exporterUrl = endpoint.endsWith("/v1/traces")
    ? endpoint
    : new URL("/v1/traces", endpoint).toString();
  const sdk = new NodeSDK({
    serviceName: "warden-gateway",
    traceExporter: new OTLPTraceExporter({ url: exporterUrl }),
  });
  sdk.start();
  return () => sdk.shutdown();
}
