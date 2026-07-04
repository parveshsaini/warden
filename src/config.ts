import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const serverNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const stdioServerSchema = z.object({
  name: z
    .string()
    .regex(serverNamePattern, "server name must be alphanumeric with dashes/underscores"),
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const wardenConfigSchema = z.object({
  servers: z
    .array(stdioServerSchema)
    .min(1, "at least one upstream server is required")
    .refine(
      (servers) => new Set(servers.map((s) => s.name)).size === servers.length,
      "server names must be unique",
    ),
});

export type ServerConfig = z.infer<typeof stdioServerSchema>;
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
