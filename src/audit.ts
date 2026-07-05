import { destination, pino } from "pino";

export interface ToolCallAuditEvent {
  event: "tools/call";
  /** Namespaced tool name as the client sent it. */
  tool: string;
  /** Upstream server the call was routed to (absent if routing failed). */
  server?: string;
  outcome: "ok" | "error" | "denied";
  /** Why the gateway denied the call, e.g. "policy" or "poisoned_output". */
  denyReason?: string;
  durationMs: number;
  error?: string;
  arguments?: Record<string, unknown>;
}

/** Emitted when the detector flags an upstream tool definition. */
export interface ToolFlaggedAuditEvent {
  event: "tool_flagged";
  /** Namespaced tool name. */
  tool: string;
  verdict: "suspicious" | "malicious";
  rules: string[];
  /** Whether the tool was quarantined (removed from the catalog and uncallable). */
  blocked: boolean;
}

export interface AuditLogger {
  toolCall(event: ToolCallAuditEvent): void;
  toolFlagged(event: ToolFlaggedAuditEvent): void;
  flush(): void;
}

export interface AuditOptions {
  path: string;
  includeArguments: boolean;
}

/** Structured JSONL audit trail of every tool call through the gateway. */
export function createAuditLogger(options: AuditOptions): AuditLogger {
  const logger = pino(
    { base: { service: "warden-gateway" } },
    destination({ dest: options.path, mkdir: true }),
  );
  return {
    toolCall(event) {
      const { arguments: args, ...rest } = event;
      logger.info(
        options.includeArguments && args !== undefined ? { ...rest, arguments: args } : rest,
      );
    },
    toolFlagged(event) {
      logger.warn(event);
    },
    flush() {
      logger.flush();
    },
  };
}
