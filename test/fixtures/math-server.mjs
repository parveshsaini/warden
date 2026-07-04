// Second stdio MCP fixture used to exercise federation in integration tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "math-fixture", version: "0.0.0" });

server.registerTool(
  "add",
  {
    description: "Adds two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

await server.connect(new StdioServerTransport());
