// Minimal stdio MCP server used as an upstream target in integration tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes back the provided message.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
  }),
);

await server.connect(new StdioServerTransport());
