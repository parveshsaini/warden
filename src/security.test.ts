import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { wardenConfigSchema } from "./config.js";
import { buildGatewayServer } from "./gateway.js";
import { SecurityEngine } from "./security.js";
import { UpstreamPool } from "./upstreams.js";

const fixtureConfig: WardenConfig = {
  servers: [
    {
      name: "px",
      transport: "stdio",
      command: process.execPath,
      args: ["test/fixtures/poisoned-server.mjs"],
      env: {},
    },
  ],
};

describe("SecurityEngine (unit)", () => {
  it("denies calls by policy rule", async () => {
    const engine = new SecurityEngine({
      policy: {
        defaultAction: "allow",
        rules: [{ action: "deny", tools: ["px__fetch_*"] }],
      },
    });
    const denial = await engine.authorizeCall({
      tool: "px__fetch_page",
      server: "px",
      toolName: "fetch_page",
    });
    expect(denial?.reason).toBe("policy");
    expect(
      await engine.authorizeCall({ tool: "px__greet", server: "px", toolName: "greet" }),
    ).toBeUndefined();
  });

  it("fails closed on approval-gated tools without a handler", async () => {
    const engine = new SecurityEngine({ approval: { tools: ["px__greet"] } });
    const denial = await engine.authorizeCall({
      tool: "px__greet",
      server: "px",
      toolName: "greet",
    });
    expect(denial?.reason).toBe("approval");
  });

  it("consults the approval handler when one is provided", async () => {
    const asked: string[] = [];
    const engine = new SecurityEngine(
      { approval: { tools: ["px__*"] } },
      {
        approve: async (request) => {
          asked.push(request.tool);
          return request.tool === "px__greet";
        },
      },
    );
    expect(
      await engine.authorizeCall({ tool: "px__greet", server: "px", toolName: "greet" }),
    ).toBeUndefined();
    const denied = await engine.authorizeCall({
      tool: "px__fetch_page",
      server: "px",
      toolName: "fetch_page",
    });
    expect(denied?.reason).toBe("approval");
    expect(asked).toEqual(["px__greet", "px__fetch_page"]);
  });

  it("denies when the rate limit is exhausted", async () => {
    const engine = new SecurityEngine({ rateLimit: { callsPerMinute: 2 } });
    const ctx = { tool: "px__greet", server: "px", toolName: "greet" };
    expect(await engine.authorizeCall(ctx)).toBeUndefined();
    expect(await engine.authorizeCall(ctx)).toBeUndefined();
    expect((await engine.authorizeCall(ctx))?.reason).toBe("rate_limit");
  });
});

describe("security gateway integration", () => {
  let pool: UpstreamPool;
  let client: Client;

  beforeAll(async () => {
    const security = new SecurityEngine(
      wardenConfigSchema.parse({
        ...fixtureConfig,
        security: {
          policy: {
            defaultAction: "allow",
            rules: [{ action: "deny", tools: ["px__blocked_tool"] }],
          },
          detector: { tier: "heuristic" },
        },
      }).security ?? {},
    );
    pool = await UpstreamPool.connect(fixtureConfig);
    const server = buildGatewayServer(pool, { security });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "security-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await pool.close();
  });

  it("quarantines the poisoned tool out of the federated catalog", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("px__greet");
    expect(names).toContain("px__fetch_page");
    expect(names).not.toContain("px__get_weather");
  });

  it("blocks calls to the quarantined tool", async () => {
    await expect(
      client.callTool({ name: "px__get_weather", arguments: { city: "Berlin" } }),
    ).rejects.toThrow(/quarantined/);
  });

  it("lets benign calls through", async () => {
    const result = await client.callTool({ name: "px__greet", arguments: { name: "Parvesh" } });
    expect(result.content).toEqual([{ type: "text", text: "Hello, Parvesh!" }]);
    expect(result.isError ?? false).toBe(false);
  });

  it("denies policy-blocked tools before reaching the upstream", async () => {
    await expect(client.callTool({ name: "px__blocked_tool", arguments: {} })).rejects.toThrow(
      /denied by policy/,
    );
  });

  it("blocks tool outputs carrying prompt injection", async () => {
    const result = await client.callTool({
      name: "px__fetch_page",
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block?.text).toContain("[warden]");
    expect(block?.text).toContain("blocked");
  });
});
