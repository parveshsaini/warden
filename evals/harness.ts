import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HeuristicDetector } from "../src/detector/index.js";
import type { Detector, Verdict } from "../src/detector/index.js";

/** One labeled tool definition from the corpus. See evals/README.md for the spec. */
export interface CorpusEntry {
  id: string;
  label: "malicious" | "benign";
  category: string;
  name: string;
  description: string;
  notes?: string;
}

export interface ScoredEntry extends CorpusEntry {
  verdict: Verdict;
  rules: string[];
  /** Predicted "should be blocked" — true iff the verdict is malicious. */
  flaggedMalicious: boolean;
}

export interface EvalMetrics {
  total: number;
  malicious: number;
  benign: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** Share of malicious entries flagged at least "suspicious" (not just blocked). */
  detectionRate: number;
  perCategoryRecall: Record<string, { caught: number; total: number }>;
  falsePositiveEntries: ScoredEntry[];
  falseNegativeEntries: ScoredEntry[];
}

export interface EvalResult {
  metrics: EvalMetrics;
  scored: ScoredEntry[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = resolve(HERE, "corpus.jsonl");

/** Reads and validates the JSONL corpus. Throws on the first malformed line. */
export function loadCorpus(path: string = DEFAULT_CORPUS): CorpusEntry[] {
  const raw = readFileSync(path, "utf8");
  const entries: CorpusEntry[] = [];
  const seen = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`corpus line ${i + 1} is not valid JSON: ${(error as Error).message}`);
    }
    const entry = parsed as Partial<CorpusEntry>;
    if (typeof entry.id !== "string" || entry.id === "") {
      throw new Error(`corpus line ${i + 1} is missing a non-empty "id"`);
    }
    if (entry.label !== "malicious" && entry.label !== "benign") {
      throw new Error(`corpus entry "${entry.id}" has an invalid "label"`);
    }
    if (typeof entry.category !== "string" || entry.category === "") {
      throw new Error(`corpus entry "${entry.id}" is missing a non-empty "category"`);
    }
    if (typeof entry.name !== "string" || typeof entry.description !== "string") {
      throw new Error(`corpus entry "${entry.id}" needs string "name" and "description"`);
    }
    if (seen.has(entry.id)) throw new Error(`duplicate corpus id "${entry.id}"`);
    seen.add(entry.id);
    entries.push(entry as CorpusEntry);
  }
  if (entries.length === 0) throw new Error(`corpus at ${path} is empty`);
  return entries;
}

/** Scores every corpus entry through the detector, exactly as the gateway screens a tool. */
export async function scoreCorpus(
  entries: CorpusEntry[],
  detector: Detector = new HeuristicDetector(),
): Promise<ScoredEntry[]> {
  const scored: ScoredEntry[] = [];
  for (const entry of entries) {
    const result = await detector.scan({
      kind: "tool_description",
      text: entry.description,
      toolName: entry.name,
    });
    scored.push({
      ...entry,
      verdict: result.verdict,
      rules: result.findings.map((f) => f.rule),
      flaggedMalicious: result.verdict === "malicious",
    });
  }
  return scored;
}

function computeMetrics(scored: ScoredEntry[]): EvalMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let detected = 0;
  const perCategoryRecall: Record<string, { caught: number; total: number }> = {};
  const falsePositiveEntries: ScoredEntry[] = [];
  const falseNegativeEntries: ScoredEntry[] = [];

  for (const entry of scored) {
    if (entry.label === "malicious") {
      const bucket = perCategoryRecall[entry.category] ?? { caught: 0, total: 0 };
      perCategoryRecall[entry.category] = bucket;
      bucket.total += 1;
      if (entry.verdict !== "clean") detected += 1;
      if (entry.flaggedMalicious) {
        tp += 1;
        bucket.caught += 1;
      } else {
        fn += 1;
        falseNegativeEntries.push(entry);
      }
    } else if (entry.flaggedMalicious) {
      fp += 1;
      falsePositiveEntries.push(entry);
    } else {
      tn += 1;
    }
  }

  const malicious = tp + fn;
  const benign = fp + tn;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = malicious === 0 ? 1 : tp / malicious;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = (tp + tn) / scored.length;
  const detectionRate = malicious === 0 ? 1 : detected / malicious;

  return {
    total: scored.length,
    malicious,
    benign,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    f1,
    accuracy,
    detectionRate,
    perCategoryRecall,
    falsePositiveEntries,
    falseNegativeEntries,
  };
}

/** Loads the corpus, scores it, and returns metrics — the entry point tests use. */
export async function runEval(
  corpusPath: string = DEFAULT_CORPUS,
  detector?: Detector,
): Promise<EvalResult> {
  const entries = loadCorpus(corpusPath);
  const scored = await scoreCorpus(entries, detector);
  return { metrics: computeMetrics(scored), scored };
}
