import { afterEach, describe, expect, it } from "vitest";
import type { WardenConfig } from "./config.js";
import { UpstreamPool } from "./upstreams.js";

function flakyConfig(overrides: Partial<WardenConfig["servers"][number]> = {}): WardenConfig {
  return {
    servers: [
      {
        name: "flaky",
        transport: "stdio",
        command: process.execPath,
        args: ["test/fixtures/flaky-server.mjs"],
        env: {},
        timeoutMs: 30_000,
        retries: 1,
        ...overrides,
      },
    ],
  };
}

describe("upstream timeouts and retries", () => {
  let pool: UpstreamPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("retries tools/list past a transient upstream failure", async () => {
    pool = await UpstreamPool.connect(flakyConfig({ retries: 1 }));
    const tools = await pool.listTools("flaky");
    expect(tools.map((tool) => tool.name)).toEqual(["sleep"]);
  });

  it("surfaces the tools/list failure when retries are disabled", async () => {
    pool = await UpstreamPool.connect(flakyConfig({ retries: 0 }));
    await expect(pool.listTools("flaky")).rejects.toThrow(/transient failure/);
  });

  it("times out a tool call that exceeds the per-server budget", async () => {
    pool = await UpstreamPool.connect(flakyConfig({ timeoutMs: 200 }));
    await expect(
      pool.callTool("flaky", { name: "sleep", arguments: { ms: 5_000 } }),
    ).rejects.toThrow(/timed out/i);
  });

  it("completes a tool call within the budget", async () => {
    pool = await UpstreamPool.connect(flakyConfig());
    const result = await pool.callTool("flaky", { name: "sleep", arguments: { ms: 10 } });
    expect(result.content).toEqual([{ type: "text", text: "slept 10ms" }]);
  });
});
