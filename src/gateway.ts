import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { WARDEN_VERSION } from "./index.js";
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

/**
 * Builds a Warden gateway MCP server backed by a shared upstream pool.
 * Tools from all upstreams are federated into one catalog, namespaced as
 * "<server>__<tool>"; calls are routed back to the owning upstream.
 *
 * Cheap to construct — one instance per client session/transport.
 */
export function buildGatewayServer(pool: UpstreamPool): Server {
  const server = new Server(
    { name: "warden", version: WARDEN_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const perServer = await Promise.all(
      pool.serverNames.map(async (serverName) => {
        const tools = await pool.listTools(serverName);
        return tools.map((tool): Tool => ({ ...tool, name: namespaceTool(serverName, tool.name) }));
      }),
    );
    return { tools: perServer.flat() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const split = splitNamespacedTool(request.params.name);
    if (!split || !pool.serverNames.includes(split.serverName)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `unknown tool "${request.params.name}" — expected "<server>${NAMESPACE_SEPARATOR}<tool>" with server one of: ${pool.serverNames.join(", ")}`,
      );
    }
    return pool.callTool(split.serverName, {
      name: split.toolName,
      ...(request.params.arguments !== undefined && { arguments: request.params.arguments }),
    });
  });

  return server;
}
