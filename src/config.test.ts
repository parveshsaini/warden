import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("parses a minimal YAML config with defaults applied", () => {
    const config = parseConfig(
      `
servers:
  - name: everything
    command: npx
    args: ["-y", "@modelcontextprotocol/server-everything"]
`,
      "yaml",
    );
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({
      name: "everything",
      transport: "stdio",
      command: "npx",
      env: {},
    });
  });

  it("parses JSON configs", () => {
    const config = parseConfig(
      JSON.stringify({ servers: [{ name: "fs", command: "node", args: ["server.js"] }] }),
      "json",
    );
    expect(config.servers[0]?.name).toBe("fs");
  });

  it("rejects an empty server list", () => {
    expect(() => parseConfig("servers: []", "yaml")).toThrow(/at least one/);
  });

  it("rejects duplicate server names", () => {
    expect(() =>
      parseConfig(
        `
servers:
  - name: a
    command: node
  - name: a
    command: node
`,
        "yaml",
      ),
    ).toThrow(/unique/);
  });

  it("parses the security block with detector defaults", () => {
    const config = parseConfig(
      `
servers:
  - name: fs
    command: node
security:
  policy:
    defaultAction: allow
    rules:
      - action: deny
        tools: ["fs__delete_*"]
  rateLimit:
    callsPerMinute: 120
  detector:
    tier: heuristic
  approval:
    tools: ["fs__write_*"]
`,
      "yaml",
    );
    expect(config.security?.policy?.rules).toHaveLength(1);
    expect(config.security?.rateLimit?.callsPerMinute).toBe(120);
    expect(config.security?.detector).toMatchObject({
      tier: "heuristic",
      scanDescriptions: true,
      scanOutputs: true,
      mode: "block",
    });
    expect(config.security?.approval?.tools).toEqual(["fs__write_*"]);
  });

  it("rejects invalid server names", () => {
    expect(() =>
      parseConfig(
        `
servers:
  - name: "bad name!"
    command: node
`,
        "yaml",
      ),
    ).toThrow(/alphanumeric/);
  });
});
