import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Measures the latency Warden adds to a tools/call.
 *
 * Three paths call the *same* tool on the *same* upstream (server-everything):
 *   - direct:      client -> server-everything                 (one stdio hop)
 *   - passthrough: client -> warden -> server-everything       (two hops)
 *   - secured:     same, with policy + rate limit + detector + audit enabled
 *
 * Because every path pays the identical upstream cost, the difference between
 * "direct" and a "warden" path is Warden's overhead — nothing else.
 */

const ITERATIONS = Number(process.argv[2] ?? 2000);
const WARMUP = Math.min(200, Math.floor(ITERATIONS / 10));
const MESSAGE = "warden-bench-payload";
const UPSTREAM_ARGS = ["-y", "@modelcontextprotocol/server-everything"];

interface Stats {
  p50: number;
  p90: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx] as number;
}

function summarize(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    mean: sum / sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

async function connect(command: string, args: string[]): Promise<Client> {
  const client = new Client({ name: "warden-bench", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
  return client;
}

interface Path {
  label: string;
  client: Client;
  tool: string;
  samples: number[];
}

async function timeOnce(path: Path): Promise<number> {
  const start = performance.now();
  await path.client.callTool({ name: path.tool, arguments: { message: MESSAGE } });
  return performance.now() - start;
}

/**
 * Interleaves the paths round-robin so every path is measured under the same
 * timeline — warmup, GC pauses, and OS scheduling jitter hit all of them
 * equally, instead of biasing whichever path is timed last.
 */
async function measureInterleaved(paths: Path[]): Promise<void> {
  for (let i = 0; i < WARMUP; i++) {
    for (const path of paths) await timeOnce(path);
  }
  for (let i = 0; i < ITERATIONS; i++) {
    for (const path of paths) path.samples.push(await timeOnce(path));
  }
}

function ms(n: number): string {
  return `${n.toFixed(3)}ms`.padStart(9);
}

function row(label: string, s: Stats): string {
  return `${label.padEnd(24)}${ms(s.p50)}${ms(s.p90)}${ms(s.p99)}${ms(s.mean)}${ms(s.min)}${ms(s.max)}`;
}

function writeConfig(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const PASSTHROUGH_CONFIG = `servers:
  - name: everything
    transport: stdio
    command: npx
    args: ${JSON.stringify(UPSTREAM_ARGS)}
`;

// Realistic "everything on" posture: policy + rate limit + description/output
// scanning + audit. The rate limit is set high enough not to throttle the run.
function securedConfig(auditPath: string): string {
  return `servers:
  - name: everything
    transport: stdio
    command: npx
    args: ${JSON.stringify(UPSTREAM_ARGS)}
observability:
  audit:
    path: ${JSON.stringify(auditPath)}
security:
  policy:
    defaultAction: allow
    rules:
      - action: deny
        tools: ["everything__get-env"]
  rateLimit:
    callsPerMinute: 100000000
  detector:
    tier: heuristic
    scanDescriptions: true
    scanOutputs: true
    mode: block
`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "warden-bench-"));
  const passthroughPath = writeConfig(dir, "passthrough.yaml", PASSTHROUGH_CONFIG);
  const securedPath = writeConfig(dir, "secured.yaml", securedConfig(join(dir, "audit.jsonl")));

  const clients: Client[] = [];
  try {
    // Direct: client -> server-everything.
    const direct = await connect("npx", UPSTREAM_ARGS);
    clients.push(direct);
    const tools = (await direct.listTools()).tools.map((t) => t.name);
    if (!tools.includes("echo")) {
      throw new Error(`upstream is missing the "echo" tool (found: ${tools.join(", ")})`);
    }

    const wardenPass = await connect("node", ["dist/cli.js", "--config", passthroughPath]);
    clients.push(wardenPass);
    const wardenSec = await connect("node", ["dist/cli.js", "--config", securedPath]);
    clients.push(wardenSec);

    const paths: Path[] = [
      { label: "direct (no gateway)", client: direct, tool: "echo", samples: [] },
      { label: "warden (passthrough)", client: wardenPass, tool: "everything__echo", samples: [] },
      { label: "warden (full security)", client: wardenSec, tool: "everything__echo", samples: [] },
    ];
    await measureInterleaved(paths);
    const [directStats, passStats, secStats] = paths.map((p) => summarize(p.samples)) as [
      Stats,
      Stats,
      Stats,
    ];

    const lines: string[] = [];
    lines.push("");
    lines.push("Warden proxy overhead — tools/call round-trip latency");
    lines.push("=".repeat(84));
    lines.push(
      `tool: echo   iterations: ${ITERATIONS} (+${WARMUP} warmup)   sequential   upstream: server-everything`,
    );
    lines.push("");
    lines.push(
      `${"path".padEnd(24)}${"p50".padStart(9)}${"p90".padStart(9)}${"p99".padStart(9)}${"mean".padStart(9)}${"min".padStart(9)}${"max".padStart(9)}`,
    );
    lines.push("-".repeat(84));
    lines.push(row("direct (no gateway)", directStats));
    lines.push(row("warden (passthrough)", passStats));
    lines.push(row("warden (full security)", secStats));
    lines.push("");
    lines.push("Warden overhead vs direct:");
    lines.push(
      `  passthrough      p50 +${(passStats.p50 - directStats.p50).toFixed(3)}ms   p99 +${(passStats.p99 - directStats.p99).toFixed(3)}ms`,
    );
    lines.push(
      `  full security    p50 +${(secStats.p50 - directStats.p50).toFixed(3)}ms   p99 +${(secStats.p99 - directStats.p99).toFixed(3)}ms`,
    );
    lines.push("");
    console.log(lines.join("\n"));
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`[bench] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
