import { destination, pino } from "pino";

export interface ToolCallAuditEvent {
  event: "tools/call";
  /** Namespaced tool name as the client sent it. */
  tool: string;
  /** Upstream server the call was routed to (absent if routing failed). */
  server?: string;
  outcome: "ok" | "error";
  durationMs: number;
  error?: string;
  arguments?: Record<string, unknown>;
}

export interface AuditLogger {
  toolCall(event: ToolCallAuditEvent): void;
  flush(): void;
}

export interface AuditOptions {
  path: string;
  includeArguments: boolean;
}

/** Structured JSONL audit trail of every tool call through the gateway. */
export function createAuditLogger(options: AuditOptions): AuditLogger {
  const logger = pino(
    { base: { service: "mcp-warden" } },
    destination({ dest: options.path, mkdir: true }),
  );
  return {
    toolCall(event) {
      const { arguments: args, ...rest } = event;
      logger.info(
        options.includeArguments && args !== undefined ? { ...rest, arguments: args } : rest,
      );
    },
    flush() {
      logger.flush();
    },
  };
}
