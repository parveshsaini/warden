import { type EvalResult, runEval } from "./harness.js";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatReport(result: EvalResult): string {
  const m = result.metrics;
  const lines: string[] = [];
  lines.push("");
  lines.push("Warden security detection benchmark — heuristic tier");
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

runEval()
  .then((result) => {
    console.log(formatReport(result));
  })
  .catch((error: unknown) => {
    console.error(`[eval] ${(error as Error).message}`);
    process.exitCode = 1;
  });
