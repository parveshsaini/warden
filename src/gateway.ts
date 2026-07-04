import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { AuditLogger } from "./audit.js";
import { WARDEN_VERSION } from "./index.js";
import type { MetricsRegistry } from "./metrics.js";
import type { Denial, DenyReason, SecurityEngine } from "./security.js";
import { getTracer } from "./telemetry.js";
import type { UpstreamPool } from "./upstreams.js";

/** Separator between the upstream server name and the tool name. */
export const NAMESPACE_SEPARATOR = "__";

export function namespaceTool(serverName: string, toolName: string): string {
  return `${serverName}${NAMESPACE_SEPARATOR}${toolName}`;
}

/**
 * Splits a namespaced tool name into server + original tool name.
 * Server names cannot contain "__" (enforced by config validation), so
 * splitting on the first separator is unambiguous.
 */
export function splitNamespacedTool(
  namespaced: string,
): { serverName: string; toolName: string } | undefined {
  const index = namespaced.indexOf(NAMESPACE_SEPARATOR);
  if (index <= 0 || index + NAMESPACE_SEPARATOR.length >= namespaced.length) {
    return undefined;
  }
  return {
    serverName: namespaced.slice(0, index),
    toolName: namespaced.slice(index + NAMESPACE_SEPARATOR.length),
  };
}

export interface GatewayHooks {
  audit?: AuditLogger;
  metrics?: MetricsRegistry;
  security?: SecurityEngine;
}

/**
 * Builds a Warden gateway MCP server backed by a shared upstream pool.
 * Tools from all upstreams are federated into one catalog, namespaced as
 * "<server>__<tool>"; calls are routed back to the owning upstream.
 *
 * Every tools/call is traced (gateway span + upstream child span), audited,
 * and counted when the corresponding hook is provided.
 *
 * Cheap to construct — one instance per client session/transport.
 */
export function buildGatewayServer(pool: UpstreamPool, hooks: GatewayHooks = {}): Server {
  const server = new Server(
    { name: "warden", version: WARDEN_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    getTracer().startActiveSpan("mcp.tools/list", { kind: SpanKind.SERVER }, async (span) => {
      try {
        const security = hooks.security;
        const perServer = await Promise.all(
          pool.serverNames.map(async (serverName) => {
            const upstreamTools = await pool.listTools(serverName);
            const namespaced = upstreamTools.map(
              (tool): Tool => ({ ...tool, name: namespaceTool(serverName, tool.name) }),
            );
            if (!security?.scansDescriptions) return namespaced;
            const allowed: Tool[] = [];
            for (const tool of namespaced) {
              const scan = await security.screenTool(tool.name, tool.description);
              if (!security.blocks(scan)) allowed.push(tool);
            }
            return allowed;
          }),
        );
        const tools = perServer.flat();
        span.setAttribute("mcp.tools.count", tools.length);
        return { tools };
      } finally {
        span.end();
      }
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    getTracer().startActiveSpan(
      `mcp.tools/call ${request.params.name}`,
      { kind: SpanKind.SERVER, attributes: { "mcp.tool.name": request.params.name } },
      async (span) => {
        const startedAt = performance.now();
        const split = splitNamespacedTool(request.params.name);
        const routed = split && pool.serverNames.includes(split.serverName) ? split : undefined;
        const security = hooks.security;
        let outcome: "ok" | "error" | "denied" = "ok";
        let denyReason: DenyReason | undefined;
        let errorMessage: string | undefined;
        const deny = (denial: Denial): McpError => {
          outcome = "denied";
          denyReason = denial.reason;
          span.setAttribute("warden.deny_reason", denial.reason);
          return new McpError(ErrorCode.InvalidRequest, `[warden] ${denial.message}`);
        };
        try {
          if (!routed) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `unknown tool "${request.params.name}" — expected "<server>${NAMESPACE_SEPARATOR}<tool>" with server one of: ${pool.serverNames.join(", ")}`,
            );
          }
          span.setAttribute("mcp.upstream.server", routed.serverName);
          span.setAttribute("mcp.upstream.tool", routed.toolName);

          if (security) {
            const denial = await security.authorizeCall({
              tool: request.params.name,
              server: routed.serverName,
              toolName: routed.toolName,
              ...(server.getClientVersion()?.name !== undefined && {
                client: server.getClientVersion()?.name,
              }),
              ...(request.params.arguments !== undefined && {
                arguments: request.params.arguments as Record<string, unknown>,
              }),
            });
            if (denial) throw deny(denial);

            if (security.scansDescriptions) {
              // screen the tool definition even if the client never listed tools
              let scan = security.screenResultFor(request.params.name);
              if (!scan) {
                const upstreamTools = await pool.listTools(routed.serverName);
                const definition = upstreamTools.find((tool) => tool.name === routed.toolName);
                if (definition) {
                  scan = await security.screenTool(request.params.name, definition.description);
                }
              }
              if (scan && security.blocks(scan)) {
                throw deny({
                  reason: "poisoned_tool",
                  message: `tool "${request.params.name}" is quarantined (flagged: ${scan.findings.map((f) => f.rule).join(", ")})`,
                });
              }
            }
          }

          // explicit parenting — does not depend on an async context manager
          const upstreamSpan = getTracer().startSpan(
            `upstream ${routed.serverName}`,
            { kind: SpanKind.CLIENT },
            trace.setSpan(context.active(), span),
          );
          let result: Awaited<ReturnType<typeof pool.callTool>>;
          try {
            result = await pool.callTool(routed.serverName, {
              name: routed.toolName,
              ...(request.params.arguments !== undefined && {
                arguments: request.params.arguments,
              }),
            });
          } finally {
            upstreamSpan.end();
          }

          if (security?.scansOutputs) {
            const scan = await security.scanOutput(request.params.name, result);
            if (scan && security.blocks(scan)) {
              const rules = scan.findings.map((f) => f.rule).join(", ");
              outcome = "denied";
              denyReason = "poisoned_output";
              span.setAttribute("warden.deny_reason", "poisoned_output");
              span.setStatus({ code: SpanStatusCode.ERROR, message: "output blocked" });
              return {
                content: [
                  {
                    type: "text",
                    text: `[warden] response from "${request.params.name}" blocked: flagged as ${scan.verdict} (${rules})`,
                  },
                ],
                isError: true,
              };
            }
          }
          return result;
        } catch (error) {
          if (outcome !== "denied") outcome = "error";
          errorMessage = error instanceof Error ? error.message : String(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
          throw error;
        } finally {
          const durationMs = performance.now() - startedAt;
          hooks.metrics?.record(request.params.name, durationMs, outcome === "ok");
          hooks.audit?.toolCall({
            event: "tools/call",
            tool: request.params.name,
            ...(routed && { server: routed.serverName }),
            outcome,
            ...(denyReason !== undefined && { denyReason }),
            durationMs: Math.round(durationMs * 100) / 100,
            ...(errorMessage !== undefined && { error: errorMessage }),
            ...(request.params.arguments !== undefined && {
              arguments: request.params.arguments as Record<string, unknown>,
            }),
          });
          span.end();
        }
      },
    ),
  );

  return server;
}
