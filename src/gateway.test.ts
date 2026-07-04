import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { type Gateway, createGateway } from "./gateway.js";

const fixtureConfig: WardenConfig = {
  servers: [
    {
      name: "echo",
      transport: "stdio",
      command: process.execPath,
      args: ["test/fixtures/echo-server.mjs"],
      env: {},
    },
  ],
};

describe("gateway passthrough", () => {
  let gateway: Gateway;
  let client: Client;

  beforeAll(async () => {
    gateway = await createGateway(fixtureConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await gateway.close();
  });

  it("forwards tools/list from the upstream server", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toContain("echo");
  });

  it("round-trips a tools/call through the gateway", async () => {
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello through warden" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: hello through warden" }]);
  });

  it("rejects configs with more than one server until federation lands", async () => {
    const [first] = fixtureConfig.servers;
    if (!first) throw new Error("fixture config is empty");
    const twoServers: WardenConfig = {
      servers: [first, { ...first, name: "echo2" }],
    };
    await expect(createGateway(twoServers)).rejects.toThrow(/exactly one/);
  });
});
