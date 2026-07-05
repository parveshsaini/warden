import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SpanKind } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditLogger } from "./audit.js";
import type { WardenConfig } from "./config.js";
import { buildGatewayServer } from "./gateway.js";
import { MetricsRegistry } from "./metrics.js";
import { UpstreamPool } from "./upstreams.js";

const fixtureConfig: WardenConfig = {
  servers: [
    {
      name: "math",
      transport: "stdio",
      command: process.execPath,
      args: ["test/fixtures/math-server.mjs"],
      env: {},
      timeoutMs: 30_000,
      retries: 1,
    },
  ],
};

const exporter = new InMemorySpanExporter();
const auditDir = mkdtempSync(join(tmpdir(), "warden-audit-"));
const auditPath = join(auditDir, "audit.jsonl");

describe("observability", () => {
  let pool: UpstreamPool;
  let client: Client;
  let metrics: MetricsRegistry;
  let audit: ReturnType<typeof createAuditLogger>;

  beforeAll(async () => {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    metrics = new MetricsRegistry();
    audit = createAuditLogger({ path: auditPath, includeArguments: true });
    pool = await UpstreamPool.connect(fixtureConfig);
    const server = buildGatewayServer(pool, { audit, metrics });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "obs-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await pool.close();
    trace.disable();
  });

  it("emits a gateway span with an upstream child span for a federated call", async () => {
    exporter.reset();
    await client.callTool({ name: "math__add", arguments: { a: 1, b: 2 } });

    const spans = exporter.getFinishedSpans();
    const gatewaySpan = spans.find((s) => s.name === "mcp.tools/call math__add");
    const upstreamSpan = spans.find((s) => s.name === "upstream math");
    expect(gatewaySpan).toBeDefined();
    expect(upstreamSpan).toBeDefined();
    expect(gatewaySpan?.kind).toBe(SpanKind.SERVER);
    expect(upstreamSpan?.kind).toBe(SpanKind.CLIENT);
    // both spans belong to one trace, with the upstream span nested under the gateway span
    expect(upstreamSpan?.spanContext().traceId).toBe(gatewaySpan?.spanContext().traceId);
    expect(upstreamSpan?.parentSpanContext?.spanId).toBe(gatewaySpan?.spanContext().spanId);
    expect(gatewaySpan?.attributes["mcp.upstream.server"]).toBe("math");
    expect(gatewaySpan?.attributes["mcp.upstream.tool"]).toBe("add");
  });

  it("records failed calls on the span and keeps serving", async () => {
    exporter.reset();
    await expect(client.callTool({ name: "unknown__tool", arguments: {} })).rejects.toThrow();
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === "mcp.tools/call unknown__tool")).toBe(true);
  });

  it("writes JSONL audit entries with outcome and duration", async () => {
    await client.callTool({ name: "math__add", arguments: { a: 20, b: 22 } });
    audit.flush();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const events = lines.map((line) => JSON.parse(line));
    const ok = events.find((e) => e.tool === "math__add" && e.outcome === "ok");
    const failed = events.find((e) => e.tool === "unknown__tool" && e.outcome === "error");
    expect(ok).toMatchObject({ event: "tools/call", server: "math", outcome: "ok" });
    expect(ok?.durationMs).toBeGreaterThanOrEqual(0);
    expect(ok?.arguments).toBeDefined();
    expect(failed).toMatchObject({ event: "tools/call", outcome: "error" });
  });

  it("counts calls and errors in metrics", () => {
    const snapshot = metrics.snapshot();
    expect(snapshot.totals.calls).toBeGreaterThanOrEqual(3);
    expect(snapshot.totals.errors).toBeGreaterThanOrEqual(1);
    expect(snapshot.perTool.math__add?.calls).toBeGreaterThanOrEqual(2);
    expect(snapshot.perTool.math__add?.errors ?? 0).toBe(0);
  });
});
