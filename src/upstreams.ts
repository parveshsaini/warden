import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, WardenConfig } from "./config.js";
import { WARDEN_VERSION } from "./index.js";

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
 * Holds one live MCP client connection per configured upstream server.
 * Shared across gateway sessions so upstream processes are spawned once.
 */
export class UpstreamPool {
  private constructor(private readonly clients: Map<string, Client>) {}

  static async connect(config: WardenConfig): Promise<UpstreamPool> {
    const entries = await Promise.all(
      config.servers.map(async (server) => [server.name, await connectUpstream(server)] as const),
    );
    return new UpstreamPool(new Map(entries));
  }

  get serverNames(): string[] {
    return [...this.clients.keys()];
  }

  private clientFor(serverName: string): Client {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`unknown upstream server "${serverName}"`);
    }
    return client;
  }

  /** Lists all tools of one upstream, following pagination cursors. */
  async listTools(serverName: string): Promise<Tool[]> {
    const client = this.clientFor(serverName);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(
    serverName: string,
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<CallToolResult> {
    const client = this.clientFor(serverName);
    return client.request({ method: "tools/call", params }, CallToolResultSchema);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((client) => client.close()));
  }
}
