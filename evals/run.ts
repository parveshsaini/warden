import {
  DEFAULT_JUDGE_MODELS,
  GeminiJudgeDetector,
  HeuristicDetector,
  JUDGE_API_KEY_ENV,
  LlmJudgeDetector,
  TieredDetector,
} from "../src/detector/index.js";
import type { Detector, JudgeUsage } from "../src/detector/index.js";
import { type EvalResult, runEval } from "./harness.js";

type Tier = "heuristic" | "llm" | "judge";
type Provider = "anthropic" | "gemini";

interface Options {
  tier: Tier;
  provider: Provider;
  model?: string;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const tier = (value("--tier") ?? "heuristic") as Tier;
  const provider = (value("--provider") ?? "gemini") as Provider;
  if (!["heuristic", "llm", "judge"].includes(tier)) {
    throw new Error(`--tier must be heuristic, llm, or judge (got "${tier}")`);
  }
  if (!["anthropic", "gemini"].includes(provider)) {
    throw new Error(`--provider must be anthropic or gemini (got "${provider}")`);
  }
  const model = value("--model");
  return { tier, provider, ...(model && { model }) };
}

/** Totals across a run, so the report can price it. */
const usage: JudgeUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * Judge calls that threw. The tiered detector degrades to the heuristic verdict
 * on failure, which is right for the gateway but would silently score an API
 * outage as a model miss — so the report has to surface it.
 */
const judgeErrors: string[] = [];

function buildDetector(options: Options): { detector: Detector; label: string } {
  const heuristic = new HeuristicDetector();
  if (options.tier === "heuristic") return { detector: heuristic, label: "heuristic tier" };

  const envVar = JUDGE_API_KEY_ENV[options.provider];
  const apiKey = process.env[envVar];
  if (!apiKey) throw new Error(`${envVar} is not set — required for --tier ${options.tier}`);
  const model = options.model ?? DEFAULT_JUDGE_MODELS[options.provider];

  const judge: Detector =
    options.provider === "gemini"
      ? new GeminiJudgeDetector({
          apiKey,
          model,
          onUsage: (u) => {
            usage.inputTokens += u.inputTokens;
            usage.outputTokens += u.outputTokens;
          },
        })
      : new LlmJudgeDetector({ apiKey, model });

  if (options.tier === "judge") return { detector: judge, label: `${model} judge only` };
  return {
    detector: new TieredDetector(heuristic, judge, (error) => {
      judgeErrors.push((error as Error).message);
    }),
    label: `heuristic + ${model} judge (tiered)`,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatReport(result: EvalResult, label: string, durationMs: number): string {
  const m = result.metrics;
  const lines: string[] = [];
  lines.push("");
  lines.push(`Warden security detection benchmark — ${label}`);
  lines.push("=".repeat(56));
  lines.push(
    `corpus:      ${m.total} tool definitions (${m.malicious} malicious, ${m.benign} benign)`,
  );
  lines.push("");
  lines.push("Blocking decision (verdict = malicious -> quarantined):");
  lines.push(
    `  precision: ${pct(m.precision)}   (${m.truePositives}/${m.truePositives + m.falsePositives} flagged were truly malicious)`,
  );
  lines.push(
    `  recall:    ${pct(m.recall)}   (${m.truePositives}/${m.malicious} malicious tools blocked)`,
  );
  lines.push(`  F1:        ${pct(m.f1)}`);
  lines.push(`  accuracy:  ${pct(m.accuracy)}`);
  lines.push("");
  lines.push("Confusion matrix:");
  lines.push(`  TP ${m.truePositives}   FP ${m.falsePositives}`);
  lines.push(`  FN ${m.falseNegatives}   TN ${m.trueNegatives}`);
  lines.push("");
  lines.push(`Detection rate (flagged >= suspicious): ${pct(m.detectionRate)} of malicious`);
  lines.push("");
  lines.push("Recall by attack category:");
  for (const [category, { caught, total }] of Object.entries(m.perCategoryRecall).sort()) {
    lines.push(`  ${category.padEnd(20)} ${caught}/${total}  ${pct(caught / total)}`);
  }
  lines.push("");
  lines.push("Run cost:");
  lines.push(
    `  wall clock: ${(durationMs / 1000).toFixed(1)}s  (${(durationMs / m.total).toFixed(0)}ms per tool)`,
  );
  if (usage.inputTokens > 0) {
    lines.push(`  tokens:     ${usage.inputTokens} in / ${usage.outputTokens} out`);
  }
  if (judgeErrors.length > 0) {
    lines.push("");
    lines.push(
      `WARNING: ${judgeErrors.length} judge call(s) failed and fell back to the heuristic verdict.`,
    );
    lines.push("These are scored as judge misses — the numbers below understate the model.");
    for (const message of [...new Set(judgeErrors)].slice(0, 3)) {
      lines.push(`  ${message.split("\n")[0]}`);
    }
  }
  if (m.falseNegativeEntries.length > 0) {
    lines.push("");
    lines.push("False negatives (malicious, not blocked):");
    for (const e of m.falseNegativeEntries) {
      const rules = e.rules.length ? `, rules=${e.rules.join(",")}` : "";
      lines.push(`  ${e.id}  [verdict=${e.verdict}${rules}]`);
    }
  }
  if (m.falsePositiveEntries.length > 0) {
    lines.push("");
    lines.push("False positives (benign, blocked):");
    for (const e of m.falsePositiveEntries) {
      lines.push(`  ${e.id}  [rules=${e.rules.join(",")}]`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { detector, label } = buildDetector(options);
  const startedAt = Date.now();
  const result = await runEval(undefined, detector);
  console.log(formatReport(result, label, Date.now() - startedAt));
}

main().catch((error: unknown) => {
  console.error(`[eval] ${(error as Error).message}`);
  process.exitCode = 1;
});
