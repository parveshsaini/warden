import type { Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { isAuthorized } from "./auth.js";
import { type GatewayHooks, buildGatewayServer } from "./gateway.js";
import type { UpstreamPool } from "./upstreams.js";

export interface HttpGatewayOptions {
  port: number;
  host: string;
  hooks?: GatewayHooks;
  /** When non-empty, POST /mcp and GET /metrics require a matching Bearer key. */
  apiKeys?: string[];
}

/**
 * Hosts the gateway over Streamable HTTP at POST /mcp.
 *
 * Runs in stateless mode: each request gets a fresh server + transport pair
 * wired to the shared upstream pool. No session state means any replica can
 * serve any request.
 */
export async function startHttpGateway(
  pool: UpstreamPool,
  options: HttpGatewayOptions,
): Promise<HttpServer> {
  const app = express();
  app.use(express.json());

  const apiKeys = options.apiKeys ?? [];
  // Guards /mcp and /metrics; /healthz stays open for load-balancer probes.
  const requireApiKey = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (apiKeys.length === 0 || isAuthorized(req.header("authorization"), apiKeys)) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", "Bearer")
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "unauthorized: missing or invalid API key" },
        id: null,
      });
  };

  app.post("/mcp", requireApiKey, async (req, res) => {
    const server = buildGatewayServer(pool, options.hooks);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[warden] error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated streams or sessions to manage.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "method not allowed" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", servers: pool.serverNames });
  });

  app.get("/metrics", requireApiKey, (_req, res) => {
    const metrics = options.hooks?.metrics;
    if (!metrics) {
      res.status(404).json({ error: "metrics not enabled" });
      return;
    }
    res.json(metrics.snapshot());
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(options.port, options.host, () => resolve(httpServer));
  });
}
