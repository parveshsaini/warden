import { setTimeout as delay } from "node:timers/promises";
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

interface Upstream {
  client: Client;
  timeoutMs: number;
  retries: number;
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

/** Retries fn up to `retries` extra attempts with a short exponential backoff. */
async function withRetries<T>(retries: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delay(100 * 2 ** (attempt - 1));
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Holds one live MCP client connection per configured upstream server.
 * Shared across gateway sessions so upstream processes are spawned once.
 */
export class UpstreamPool {
  private constructor(private readonly upstreams: Map<string, Upstream>) {}

  static async connect(config: WardenConfig): Promise<UpstreamPool> {
    const entries = await Promise.all(
      config.servers.map(async (server) => {
        const upstream: Upstream = {
          client: await connectUpstream(server),
          timeoutMs: server.timeoutMs,
          retries: server.retries,
        };
        return [server.name, upstream] as const;
      }),
    );
    return new UpstreamPool(new Map(entries));
  }

  get serverNames(): string[] {
    return [...this.upstreams.keys()];
  }

  private upstreamFor(serverName: string): Upstream {
    const upstream = this.upstreams.get(serverName);
    if (!upstream) {
      throw new Error(`unknown upstream server "${serverName}"`);
    }
    return upstream;
  }

  /**
   * Lists all tools of one upstream, following pagination cursors.
   * tools/list is idempotent, so transient failures are retried.
   */
  async listTools(serverName: string): Promise<Tool[]> {
    const upstream = this.upstreamFor(serverName);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withRetries(upstream.retries, () =>
        upstream.client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: upstream.timeoutMs,
        }),
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  /** Never retried: tool calls can have side effects a gateway must not replay. */
  async callTool(
    serverName: string,
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<CallToolResult> {
    const upstream = this.upstreamFor(serverName);
    return upstream.client.request({ method: "tools/call", params }, CallToolResultSchema, {
      timeout: upstream.timeoutMs,
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.upstreams.values()].map((upstream) => upstream.client.close()),
    );
  }
}
