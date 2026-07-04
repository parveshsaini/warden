import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { startHttpGateway } from "./http.js";
import { UpstreamPool } from "./upstreams.js";

const fixtureConfig: WardenConfig = {
  servers: [
    {
      name: "echo",
      transport: "stdio",
      command: process.execPath,
      args: ["test/fixtures/echo-server.mjs"],
      env: {},
    },
    {
      name: "math",
      transport: "stdio",
      command: process.execPath,
      args: ["test/fixtures/math-server.mjs"],
      env: {},
    },
  ],
};

describe("streamable HTTP gateway", () => {
  let pool: UpstreamPool;
  let httpServer: HttpServer;
  let client: Client;

  beforeAll(async () => {
    pool = await UpstreamPool.connect(fixtureConfig);
    httpServer = await startHttpGateway(pool, { port: 0, host: "127.0.0.1" });
    const { port } = httpServer.address() as AddressInfo;
    client = new Client({ name: "http-test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
  });

  afterAll(async () => {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await pool.close();
  });

  it("serves the federated catalog over HTTP", async () => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("echo__echo");
    expect(names).toContain("math__add");
  });

  it("round-trips a namespaced tool call over HTTP", async () => {
    const result = await client.callTool({
      name: "math__add",
      arguments: { a: 20, b: 22 },
    });
    expect(result.content).toEqual([{ type: "text", text: "42" }]);
  });
});
