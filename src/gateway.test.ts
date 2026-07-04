import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { buildGatewayServer, namespaceTool, splitNamespacedTool } from "./gateway.js";
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

describe("tool namespacing", () => {
  it("round-trips server/tool names", () => {
    expect(namespaceTool("fs", "read_file")).toBe("fs__read_file");
    expect(splitNamespacedTool("fs__read_file")).toEqual({
      serverName: "fs",
      toolName: "read_file",
    });
  });

  it("splits on the first separator only", () => {
    expect(splitNamespacedTool("a__b__c")).toEqual({ serverName: "a", toolName: "b__c" });
  });

  it("returns undefined for names without a namespace", () => {
    expect(splitNamespacedTool("plain")).toBeUndefined();
    expect(splitNamespacedTool("__tool")).toBeUndefined();
    expect(splitNamespacedTool("server__")).toBeUndefined();
  });
});

describe("federated gateway", () => {
  let pool: UpstreamPool;
  let client: Client;

  beforeAll(async () => {
    pool = await UpstreamPool.connect(fixtureConfig);
    const server = buildGatewayServer(pool);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await pool.close();
  });

  it("federates tools from all upstreams into one namespaced catalog", async () => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("echo__echo");
    expect(names).toContain("math__add");
  });

  it("routes namespaced calls to the owning upstream", async () => {
    const echoResult = await client.callTool({
      name: "echo__echo",
      arguments: { message: "federated" },
    });
    expect(echoResult.content).toEqual([{ type: "text", text: "echo: federated" }]);

    const mathResult = await client.callTool({
      name: "math__add",
      arguments: { a: 2, b: 40 },
    });
    expect(mathResult.content).toEqual([{ type: "text", text: "42" }]);
  });

  it("rejects calls to unknown namespaces with a helpful error", async () => {
    await expect(client.callTool({ name: "nope__tool", arguments: {} })).rejects.toThrow(
      /unknown tool/,
    );
    await expect(client.callTool({ name: "unnamespaced", arguments: {} })).rejects.toThrow(
      /unknown tool/,
    );
  });
});
