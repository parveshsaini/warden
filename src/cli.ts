#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuditLogger } from "./audit.js";
import { loadConfigFile } from "./config.js";
import { type GatewayHooks, buildGatewayServer } from "./gateway.js";
import { startHttpGateway } from "./http.js";
import { WARDEN_VERSION } from "./index.js";
import { MetricsRegistry } from "./metrics.js";
import { startTelemetry } from "./telemetry.js";
import { UpstreamPool } from "./upstreams.js";

const DEFAULT_CONFIG_CANDIDATES = ["warden.config.yaml", "warden.config.yml", "warden.config.json"];

// stdout is the MCP protocol channel in stdio mode — human-readable output goes to stderr.
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
  log(
    `config loaded from ${configPath} (${config.servers.length} upstream server${config.servers.length === 1 ? "" : "s"})`,
  );

  const stopTelemetry = startTelemetry(config);
  if (stopTelemetry) log("otel tracing enabled");

  const hooks: GatewayHooks = { metrics: new MetricsRegistry() };
  if (config.observability?.audit) {
    hooks.audit = createAuditLogger(config.observability.audit);
    log(`audit log: ${config.observability.audit.path}`);
  }

  const pool = await UpstreamPool.connect(config);
  log(`upstreams connected: ${pool.serverNames.join(", ")}`);

  const shutdown = async () => {
    hooks.audit?.flush();
    await pool.close();
    await stopTelemetry?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (argv.includes("--http")) {
    const listen = config.http ?? { port: 3000, host: "127.0.0.1" };
    await startHttpGateway(pool, { ...listen, hooks });
    log(`mcp-warden v${WARDEN_VERSION} listening on http://${listen.host}:${listen.port}/mcp`);
    return;
  }

  const server = buildGatewayServer(pool, hooks);
  await server.connect(new StdioServerTransport());
  log(`mcp-warden v${WARDEN_VERSION} ready on stdio`);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
