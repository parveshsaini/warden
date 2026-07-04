import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, WardenConfig } from "./config.js";
import { WARDEN_VERSION } from "./index.js";

export interface Gateway {
  server: Server;
  close(): Promise<void>;
}

async function connectUpstream(config: ServerConfig): Promise<Client> {
  const client = new Client({ name: "warden", version: WARDEN_VERSION });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "inherit",
  });
  await client.connect(transport);
  return client;
}

/**
 * Creates the Warden gateway: an MCP server that proxies tools/list and
 * tools/call to one upstream MCP server. Federation across multiple
 * upstreams lands in C2.
 */
export async function createGateway(config: WardenConfig): Promise<Gateway> {
  const upstreamConfig = config.servers[0];
  if (!upstreamConfig || config.servers.length !== 1) {
    throw new Error(
      `expected exactly one upstream server (federation lands in C2), got ${config.servers.length}`,
    );
  }

  const upstream = await connectUpstream(upstreamConfig);

  const server = new Server(
    { name: "warden", version: WARDEN_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    upstream.request({ method: "tools/list", params: request.params }, ListToolsResultSchema),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    upstream.request({ method: "tools/call", params: request.params }, CallToolResultSchema),
  );

  return {
    server,
    close: async () => {
      await upstream.close();
      await server.close();
    },
  };
}
