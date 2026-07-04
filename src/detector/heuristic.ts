import type { Detector, Finding, ScanInput, ScanResult, Verdict } from "./types.js";

interface HeuristicRule {
  id: string;
  severity: "medium" | "high";
  pattern: RegExp;
}

/**
 * Pattern rules for known tool-poisoning / prompt-injection tells.
 * High-severity rules target patterns with essentially no benign use inside
 * a tool description or tool output.
 */
const RULES: HeuristicRule[] = [
  {
    // "ignore all previous instructions", "disregard the above rules", ...
    id: "instruction-override",
    severity: "high",
    pattern:
      /\b(ignore|disregard|forget|override)\b[\s\S]{0,30}\b(previous|prior|above|earlier|all|any|system)\b[\s\S]{0,20}\b(instructions?|rules?|prompts?|guidelines?|directives?)\b/i,
  },
  {
    // "do not tell the user", "without informing the user", "keep this secret"
    id: "concealment",
    severity: "high",
    pattern:
      /\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|show|notify|alert|disclose)\b[\s\S]{0,30}\b(user|human|anyone)\b|\bwithout\s+(telling|informing|notifying|alerting)\b|\bkeep\s+(this|it)\s+(secret|hidden|private\s+from)\b/i,
  },
  {
    // <IMPORTANT>...</IMPORTANT> and friends — the classic MCP tool-poisoning wrapper
    id: "hidden-tag",
    severity: "high",
    pattern: /<\s*(important|system|secret|hidden|instructions?|admin)\b[^>]*>/i,
  },
  {
    // verbs acting on credential material / sensitive paths
    id: "sensitive-file",
    severity: "high",
    pattern:
      /\b(read|cat|open|fetch|load|access|include|send|pass|append|copy|upload|attach|extract)\b[\s\S]{0,60}(\.ssh\b|id_rsa|id_ed25519|\.aws\b|\/etc\/passwd|\/etc\/shadow|\.env\b|\.npmrc\b|\.git-credentials|private\s+key|ssh\s+key|keychain)/i,
  },
  {
    // sending data to an external URL
    id: "exfiltration",
    severity: "high",
    pattern: /\b(send|post|forward|upload|transmit|share|exfiltrate)\b[\s\S]{0,60}\bhttps?:\/\//i,
  },
  {
    // secrets solicited as parameters or into output
    id: "credential-harvest",
    severity: "medium",
    pattern:
      /\b(password|secret|token|api[-_ ]?key|credential)s?\b[\s\S]{0,40}\b(send|include|pass|append|share|provide|paste|embed)\b|\b(send|include|pass|append|share|provide|paste|embed)\b[\s\S]{0,40}\b(password|secret|token|api[-_ ]?key|credential)s?\b/i,
  },
  {
    // cross-tool manipulation: "instead of the X tool", "before using this tool, ..."
    id: "tool-shadowing",
    severity: "medium",
    pattern:
      /\binstead\s+of\b[\s\S]{0,40}\btool\b|\bbefore\s+(using|calling|invoking)\s+(this|any|other)\b[\s\S]{0,20}\btools?\b|\b(do\s+not|don'?t|never)\s+(use|call|invoke)\b[\s\S]{0,30}\btool\b/i,
  },
  {
    // "you are now ...", "your new role", "act as ..."
    id: "role-hijack",
    severity: "medium",
    pattern:
      /\byou\s+(are|'re)\s+(now|actually)\b|\bnew\s+(instructions|role|task|persona)\b|\bact\s+as\s+(a|an|the)\b/i,
  },
  {
    // zero-width / invisible characters have no place in a tool description
    id: "invisible-chars",
    severity: "high",
    pattern: /\u200b|\u200c|\u200d|\u2060|\u2062|\u2063|\u00ad|\ufeff|[\u{E0000}-\u{E007F}]/u,
  },
  {
    // long opaque base64 blob — payload smuggling
    id: "encoded-blob",
    severity: "medium",
    pattern: /[A-Za-z0-9+/]{80,}={0,2}/,
  },
];

function excerptOf(match: string): string {
  const flat = match.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function verdictFor(findings: Finding[]): Verdict {
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  if (high > 0 || medium >= 2) return "malicious";
  if (medium === 1) return "suspicious";
  return "clean";
}

/** Rule-based tier — works with no API key and no network access. */
export class HeuristicDetector implements Detector {
  readonly name = "heuristic";

  scan(input: ScanInput): Promise<ScanResult> {
    const findings: Finding[] = [];
    for (const rule of RULES) {
      const match = rule.pattern.exec(input.text);
      if (match) {
        const excerpt = excerptOf(match[0]);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          excerpt: excerpt === "" ? "(invisible characters)" : excerpt,
        });
      }
    }
    return Promise.resolve({ verdict: verdictFor(findings), findings, detector: this.name });
  }
}
