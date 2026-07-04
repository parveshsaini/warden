import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLogger } from "./audit.js";
import type { SecurityConfig } from "./config.js";
import { type Detector, type ScanResult, createDetector } from "./detector/index.js";
import { evaluatePolicy, matchesPattern } from "./policy.js";
import { RateLimiter } from "./ratelimit.js";

export type DenyReason = "policy" | "rate_limit" | "approval" | "poisoned_tool" | "poisoned_output";

export interface Denial {
  reason: DenyReason;
  message: string;
}

export interface CallContext {
  /** Namespaced tool name as the client sent it. */
  tool: string;
  server: string;
  /** Original (un-namespaced) tool name on the upstream. */
  toolName: string;
  /** MCP client name from the initialize handshake, when known. */
  client?: string;
  arguments?: Record<string, unknown>;
}

/** Asked before every call to a tool matching an approval pattern. */
export type ApprovalHandler = (request: CallContext) => Promise<boolean>;

export interface SecurityEngineOptions {
  /**
   * Approves calls to tools listed under `security.approval`. Without a
   * handler such calls are denied — fail closed.
   */
  approve?: ApprovalHandler;
  audit?: Pick<AuditLogger, "toolFlagged">;
  onJudgeError?: (error: unknown) => void;
}

/**
 * Enforces the config-driven security layer: policy rules, rate limiting,
 * approval gating, and detector-based scanning of tool descriptions and
 * tool outputs. One instance per gateway process — scan results are cached
 * per tool definition, and the rate limit budget is shared.
 */
export class SecurityEngine {
  readonly detectorTier: "heuristic" | "llm" | "off";
  private readonly detector?: Detector;
  private readonly limiter?: RateLimiter;
  private readonly screenCache = new Map<string, { description: string; result: ScanResult }>();

  constructor(
    private readonly config: SecurityConfig,
    private readonly options: SecurityEngineOptions = {},
  ) {
    if (config.rateLimit) this.limiter = new RateLimiter(config.rateLimit.callsPerMinute);
    if (config.detector) {
      const created = createDetector(config.detector, {
        ...(options.onJudgeError && { onJudgeError: options.onJudgeError }),
      });
      this.detector = created.detector;
      this.detectorTier = created.tier;
    } else {
      this.detectorTier = "off";
    }
  }

  get scansDescriptions(): boolean {
    return this.detector !== undefined && this.config.detector?.scanDescriptions === true;
  }

  get scansOutputs(): boolean {
    return this.detector !== undefined && this.config.detector?.scanOutputs === true;
  }

  /** Whether this scan verdict blocks the tool/response (vs warn-only). */
  blocks(result: ScanResult): boolean {
    return result.verdict === "malicious" && this.config.detector?.mode === "block";
  }

  /** Policy → approval → rate limit. Returns the denial, or undefined to allow. */
  async authorizeCall(ctx: CallContext): Promise<Denial | undefined> {
    if (this.config.policy) {
      const input =
        ctx.client === undefined ? { tool: ctx.tool } : { tool: ctx.tool, client: ctx.client };
      const decision = evaluatePolicy(this.config.policy, input);
      if (decision.action === "deny") {
        const via = decision.matchedRule
          ? `rule [${decision.matchedRule.tools.join(", ")}]`
          : "default action";
        return { reason: "policy", message: `call to "${ctx.tool}" denied by policy (${via})` };
      }
    }
    if (this.config.approval?.tools.some((pattern) => matchesPattern(pattern, ctx.tool))) {
      const approved = this.options.approve ? await this.options.approve(ctx) : false;
      if (!approved) {
        return {
          reason: "approval",
          message: this.options.approve
            ? `call to "${ctx.tool}" was not approved`
            : `"${ctx.tool}" requires approval and no approval handler is configured`,
        };
      }
    }
    if (this.limiter && !this.limiter.tryAcquire()) {
      return {
        reason: "rate_limit",
        message: `rate limit exceeded (${this.config.rateLimit?.callsPerMinute} calls/minute)`,
      };
    }
    return undefined;
  }

  /**
   * Scans a tool description, cached per (tool, description) so repeated
   * tools/list calls don't re-scan. Flags are audited once per fresh scan.
   */
  async screenTool(namespacedTool: string, description: string | undefined): Promise<ScanResult> {
    if (!this.detector) return { verdict: "clean", findings: [], detector: "off" };
    const text = description ?? "";
    const cached = this.screenCache.get(namespacedTool);
    if (cached && cached.description === text) return cached.result;
    const result = await this.detector.scan({
      kind: "tool_description",
      text,
      toolName: namespacedTool,
    });
    this.screenCache.set(namespacedTool, { description: text, result });
    if (result.verdict !== "clean") {
      this.options.audit?.toolFlagged({
        event: "tool_flagged",
        tool: namespacedTool,
        verdict: result.verdict,
        rules: result.findings.map((f) => f.rule),
        blocked: this.blocks(result),
      });
    }
    return result;
  }

  /** Last screen result for a tool, if it has been screened this process. */
  screenResultFor(namespacedTool: string): ScanResult | undefined {
    return this.screenCache.get(namespacedTool)?.result;
  }

  /** Scans the text content of a tool call result for prompt injection. */
  async scanOutput(
    namespacedTool: string,
    result: CallToolResult,
  ): Promise<ScanResult | undefined> {
    if (!this.detector) return undefined;
    const text = (result.content ?? [])
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text === "") return undefined;
    return this.detector.scan({ kind: "tool_output", text, toolName: namespacedTool });
  }
}
