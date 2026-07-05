import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const serverNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const stdioServerSchema = z.object({
  name: z
    .string()
    .regex(serverNamePattern, "server name must be alphanumeric with dashes/underscores")
    .refine(
      (name) => !name.includes("__"),
      "server name must not contain '__' (reserved as the tool namespace separator)",
    ),
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Per-request timeout for requests forwarded to this upstream (ms). */
  timeoutMs: z.number().int().min(1).default(30_000),
  /**
   * Retry budget for idempotent requests (tools/list) against this upstream.
   * tools/call is deliberately never retried — tool calls can have side
   * effects, and a gateway must not replay them.
   */
  retries: z.number().int().min(0).max(5).default(1),
});

export const httpListenSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("127.0.0.1"),
  auth: z
    .object({
      /**
       * Bearer keys accepted on POST /mcp and GET /metrics. Keys can also be
       * supplied via the WARDEN_API_KEYS env var (comma-separated) so they
       * don't have to live in the config file.
       */
      apiKeys: z.array(z.string().min(8, "API keys must be at least 8 characters")).min(1),
    })
    .optional(),
});

export const observabilitySchema = z.object({
  /**
   * OTLP/HTTP traces endpoint (e.g. "http://localhost:4318/v1/traces").
   * Falls back to OTEL_EXPORTER_OTLP_ENDPOINT; tracing is off when neither is set.
   */
  otlpEndpoint: z.string().url().optional(),
  audit: z
    .object({
      /** JSONL audit log destination. */
      path: z.string().default("warden-audit.jsonl"),
      /** Tool call arguments are redacted from the audit log unless enabled. */
      includeArguments: z.boolean().default(false),
    })
    .optional(),
});

export const policyRuleSchema = z.object({
  action: z.enum(["allow", "deny"]),
  /** Namespaced tool patterns; "*" wildcards, e.g. "fs__delete_*". */
  tools: z.array(z.string().min(1)).min(1),
  /**
   * Optional MCP client-name patterns this rule applies to. Client identity
   * comes from the MCP initialize handshake; rules with `clients` only match
   * when the client name is known.
   */
  clients: z.array(z.string().min(1)).optional(),
});

export const policySchema = z.object({
  defaultAction: z.enum(["allow", "deny"]).default("allow"),
  /** First matching rule wins. */
  rules: z.array(policyRuleSchema).default([]),
});

export const detectorSchema = z.object({
  /** "heuristic" needs no API key; "llm" adds a Claude judge via ANTHROPIC_API_KEY. */
  tier: z.enum(["heuristic", "llm"]).default("heuristic"),
  model: z.string().default("claude-haiku-4-5-20251001"),
  /** Scan upstream tool descriptions; malicious tools are quarantined. */
  scanDescriptions: z.boolean().default(true),
  /** Scan tool call results for prompt injection before they reach the client. */
  scanOutputs: z.boolean().default(true),
  /** "block" rejects malicious tools/outputs; "warn" only audits them. */
  mode: z.enum(["block", "warn"]).default("block"),
});

export const securitySchema = z.object({
  policy: policySchema.optional(),
  rateLimit: z
    .object({
      /** Global tools/call budget for this gateway process (token bucket). */
      callsPerMinute: z.number().int().min(1),
    })
    .optional(),
  detector: detectorSchema.optional(),
  approval: z
    .object({
      /** Namespaced tool patterns that require approval before every call. */
      tools: z.array(z.string().min(1)).min(1),
    })
    .optional(),
});

export const wardenConfigSchema = z.object({
  servers: z
    .array(stdioServerSchema)
    .min(1, "at least one upstream server is required")
    .refine(
      (servers) => new Set(servers.map((s) => s.name)).size === servers.length,
      "server names must be unique",
    ),
  http: httpListenSchema.optional(),
  observability: observabilitySchema.optional(),
  security: securitySchema.optional(),
});

export type ServerConfig = z.infer<typeof stdioServerSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type DetectorConfig = z.infer<typeof detectorSchema>;
export type SecurityConfig = z.infer<typeof securitySchema>;
export type WardenConfig = z.infer<typeof wardenConfigSchema>;

export function parseConfig(text: string, format: "yaml" | "json"): WardenConfig {
  const raw: unknown = format === "json" ? JSON.parse(text) : parseYaml(text);
  return wardenConfigSchema.parse(raw);
}

export function loadConfigFile(path: string): WardenConfig {
  const text = readFileSync(path, "utf8");
  const format = extname(path) === ".json" ? "json" : "yaml";
  return parseConfig(text, format);
}
