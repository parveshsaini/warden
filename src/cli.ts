#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFile } from "./config.js";
import { createGateway } from "./gateway.js";
import { WARDEN_VERSION } from "./index.js";

const DEFAULT_CONFIG_CANDIDATES = ["warden.config.yaml", "warden.config.yml", "warden.config.json"];

// stdout is the MCP protocol channel — everything human-readable goes to stderr.
function log(message: string): void {
  console.error(`[warden] ${message}`);
}

function resolveConfigPath(argv: string[]): string {
  const flagIndex = argv.indexOf("--config");
  if (flagIndex !== -1) {
    const path = argv[flagIndex + 1];
    if (!path) {
      log("--config requires a path");
      process.exit(1);
    }
    return path;
  }
  const found = DEFAULT_CONFIG_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    log(
      `no config found; pass --config <path> or create one of: ${DEFAULT_CONFIG_CANDIDATES.join(", ")}`,
    );
    process.exit(1);
  }
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(WARDEN_VERSION);
    return;
  }

  const configPath = resolveConfigPath(argv);
  const config = loadConfigFile(configPath);
  log(`config loaded from ${configPath} (${config.servers.length} upstream server)`);

  const gateway = await createGateway(config);
  const shutdown = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.server.connect(new StdioServerTransport());
  log(`mcp-warden v${WARDEN_VERSION} ready on stdio, proxying "${config.servers[0]?.name}"`);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
