import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { startHttpGateway } from "./http.js";
import { UpstreamPool } from "./upstreams.js";

const echoServer: WardenConfig["servers"][number] = {
  name: "echo",
  transport: "stdio",
  command: process.execPath,
  args: ["test/fixtures/echo-server.mjs"],
  env: {},
  timeoutMs: 30_000,
  retries: 1,
};

const fixtureConfig: WardenConfig = {
  servers: [
    echoServer,
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

describe("streamable HTTP gateway with API-key auth", () => {
  const API_KEY = "test-api-key-long-enough";
  let pool: UpstreamPool;
  let httpServer: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    pool = await UpstreamPool.connect({ servers: [echoServer] });
    httpServer = await startHttpGateway(pool, {
      port: 0,
      host: "127.0.0.1",
      apiKeys: [API_KEY],
    });
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await pool.close();
  });

  it("rejects /mcp without a key", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects /mcp with a wrong key", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-the-right-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("serves an authenticated MCP client", async () => {
    const client = new Client({ name: "http-auth-test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${API_KEY}` } },
      }),
    );
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toContain("echo__echo");
    } finally {
      await client.close();
    }
  });

  it("keeps /healthz open for probes", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});
