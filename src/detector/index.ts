import type { DetectorConfig } from "../config.js";
import { HeuristicDetector } from "./heuristic.js";
import { LlmJudgeDetector } from "./llm.js";
import { type Detector, type ScanInput, type ScanResult, worseVerdict } from "./types.js";

export { HeuristicDetector } from "./heuristic.js";
export { LlmJudgeDetector } from "./llm.js";
export type { Detector, Finding, ScanInput, ScanResult, Verdict } from "./types.js";

/**
 * Runs the cheap tier first and only escalates to the judge when the cheap
 * tier didn't already conclude "malicious". Judge failures degrade to the
 * cheap tier's result — the gateway must keep working without the API.
 */
export class TieredDetector implements Detector {
  readonly name: string;

  constructor(
    private readonly primary: Detector,
    private readonly judge: Detector,
    private readonly onJudgeError?: (error: unknown) => void,
  ) {
    this.name = `${primary.name}+${judge.name}`;
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const first = await this.primary.scan(input);
    if (first.verdict === "malicious") return first;
    try {
      const second = await this.judge.scan(input);
      return {
        verdict: worseVerdict(first.verdict, second.verdict),
        findings: [...first.findings, ...second.findings],
        detector: this.name,
      };
    } catch (error) {
      this.onJudgeError?.(error);
      return first;
    }
  }
}

/**
 * Builds the detector for a config. The "llm" tier requires ANTHROPIC_API_KEY;
 * without one it falls back to heuristic-only (and reports that via `tier`).
 */
export function createDetector(
  config: DetectorConfig,
  options: { onJudgeError?: (error: unknown) => void } = {},
): { detector: Detector; tier: "heuristic" | "llm" } {
  const heuristic = new HeuristicDetector();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (config.tier === "llm" && apiKey) {
    const judge = new LlmJudgeDetector({ apiKey, model: config.model });
    return { detector: new TieredDetector(heuristic, judge, options.onJudgeError), tier: "llm" };
  }
  return { detector: heuristic, tier: "heuristic" };
}
