import type { PolicyConfig, PolicyRule } from "./config.js";

/** Matches a "*"-wildcard pattern against a value (full match, case-sensitive). */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export interface PolicyInput {
  /** Namespaced tool name as the client sent it. */
  tool: string;
  /** MCP client name from the initialize handshake, when known. */
  client?: string;
}

export interface PolicyDecision {
  action: "allow" | "deny";
  /** The rule that decided, absent when the default action applied. */
  matchedRule?: PolicyRule;
}

/** Evaluates first-match-wins rules, falling back to the default action. */
export function evaluatePolicy(policy: PolicyConfig, input: PolicyInput): PolicyDecision {
  for (const rule of policy.rules) {
    if (!rule.tools.some((pattern) => matchesPattern(pattern, input.tool))) continue;
    if (rule.clients) {
      const client = input.client;
      if (client === undefined) continue;
      if (!rule.clients.some((pattern) => matchesPattern(pattern, client))) continue;
    }
    return { action: rule.action, matchedRule: rule };
  }
  return { action: policy.defaultAction };
}
