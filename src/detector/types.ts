export type Verdict = "clean" | "suspicious" | "malicious";

export interface ScanInput {
  /** What is being scanned — a tool definition or a tool call result. */
  kind: "tool_description" | "tool_output";
  text: string;
  /** Namespaced tool name, for context. */
  toolName?: string;
}

export interface Finding {
  /** Stable rule identifier, e.g. "instruction-override" or "llm-judge". */
  rule: string;
  severity: "medium" | "high";
  /** The matched text (truncated) or the judge's reasoning. */
  excerpt: string;
}

export interface ScanResult {
  verdict: Verdict;
  findings: Finding[];
  /** Which detector produced this result. */
  detector: string;
}

export interface Detector {
  readonly name: string;
  scan(input: ScanInput): Promise<ScanResult>;
}

const VERDICT_RANK: Record<Verdict, number> = { clean: 0, suspicious: 1, malicious: 2 };

export function worseVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}
