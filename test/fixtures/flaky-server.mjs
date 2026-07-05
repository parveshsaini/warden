// Stdio MCP server for timeout/retry tests: the first tools/list request
// always fails, and its "sleep" tool takes as long as the caller asks.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "flaky-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

let listAttempts = 0;
server.setRequestHandler(ListToolsRequestSchema, async () => {
  listAttempts += 1;
  if (listAttempts === 1) {
    throw new Error("transient failure (first tools/list always fails)");
  }
  return {
    tools: [
      {
        name: "sleep",
        description: "Waits for ms milliseconds, then returns.",
        inputSchema: {
          type: "object",
          properties: { ms: { type: "number" } },
          required: ["ms"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const ms = Number(request.params.arguments?.ms ?? 0);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { content: [{ type: "text", text: `slept ${ms}ms` }] };
});

await server.connect(new StdioServerTransport());
