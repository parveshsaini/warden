import { describe, expect, it } from "vitest";
import { loadCorpus, runEval, scoreCorpus } from "./harness.js";

describe("security eval corpus", () => {
  it("is well-formed, balanced, and non-trivial", () => {
    const entries = loadCorpus();
    expect(entries.length).toBeGreaterThanOrEqual(80);
    const malicious = entries.filter((e) => e.label === "malicious").length;
    const benign = entries.filter((e) => e.label === "benign").length;
    expect(malicious).toBeGreaterThanOrEqual(30);
    expect(benign).toBeGreaterThanOrEqual(30);
  });

  it("scores every entry with a verdict", async () => {
    const entries = loadCorpus();
    const scored = await scoreCorpus(entries);
    expect(scored).toHaveLength(entries.length);
    for (const entry of scored) {
      expect(["clean", "suspicious", "malicious"]).toContain(entry.verdict);
    }
  });
});

describe("heuristic detector benchmark", () => {
  // Committed floors: the heuristic tier is deterministic and offline, so these
  // guard against silent regressions when rules or the corpus change. Margins
  // sit below the current numbers so the corpus can grow without churn.
  //
  // These dropped sharply when the corpus grew from 93 to 193 entries. That is
  // a corpus change, not a rules regression: the 100 added entries deliberately
  // cover attack families the rules were never written for (rug pulls, schema
  // injection, homoglyphs, persistence), and the heuristic tier blocks none of
  // them. The rules were left untouched on purpose so the benchmark keeps
  // measuring them against an independent target rather than being retrofitted
  // to pass. Recall here is a floor for the *offline* tier only — the llm tier
  // is what closes the gap. See docs/llm-judge-benchmark.md.
  it("meets the committed precision/recall floors", async () => {
    const { metrics } = await runEval();
    expect(metrics.precision).toBeGreaterThanOrEqual(0.85);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.4);
    expect(metrics.f1).toBeGreaterThanOrEqual(0.54);
  });

  it("blocks the classic hidden-tag tool-poisoning attack", async () => {
    const { scored } = await runEval();
    const poisoned = scored.find((e) => e.id === "mal-hidden-tag-01");
    expect(poisoned?.verdict).toBe("malicious");
  });

  it("does not block a plain benign file-read tool", async () => {
    const { scored } = await runEval();
    const benign = scored.find((e) => e.id === "ben-read-file-01");
    expect(benign?.flaggedMalicious).toBe(false);
  });
});
