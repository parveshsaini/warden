# Warden performance benchmark

How much latency does putting Warden in front of an MCP server actually cost?
This benchmark answers that with p50/p90/p99 numbers you can reproduce:

```bash
pnpm build          # bench spawns the compiled dist/cli.js
pnpm bench          # 2000 iterations (default); `pnpm bench 5000` for more
```

## Method

Three paths call the **same tool** (`echo`) on the **same upstream**
(`@modelcontextprotocol/server-everything`), over stdio:

| path                     | topology                                    |
| ------------------------ | ------------------------------------------- |
| `direct (no gateway)`    | client → server-everything                  |
| `warden (passthrough)`   | client → warden → server-everything         |
| `warden (full security)` | same, with policy + rate limit + detector (scanning descriptions **and** every output) + audit log all enabled |

Because every path pays the identical upstream cost, the difference between
`direct` and a `warden` path **is** Warden's overhead — the extra stdio hop plus
whatever processing that path enables. Nothing else is in the delta.

To keep the comparison fair the harness:

- **interleaves** the three paths round-robin — each iteration times one call on
  each path — so warmup, GC pauses, and OS scheduling jitter hit all three
  equally instead of biasing whichever path runs last;
- **warms up** (200 calls per path) before timing;
- issues calls **sequentially** (no concurrency) so each sample is a true
  single-call round-trip;
- uses a **fixed small payload** so serialization cost is constant;
- runs the full-security path with the rate limit set high enough that it never
  throttles the run — the token-bucket check still executes on every call.

## Representative result

From one run on a developer laptop (Windows, Node 22). Absolute numbers are
machine-dependent — **reproduce your own with `pnpm bench`** — but the *delta*
between paths is the portable takeaway.

```
tool: echo   iterations: 2000 (+200 warmup)   sequential   upstream: server-everything

path                          p50      p90      p99     mean      min      max
------------------------------------------------------------------------------------
direct (no gateway)       0.513ms  0.772ms  1.487ms  0.562ms  0.253ms  5.235ms
warden (passthrough)      1.115ms  1.596ms  3.110ms  1.214ms  0.577ms 15.793ms
warden (full security)    1.208ms  1.616ms  2.782ms  1.278ms  0.681ms  7.192ms

Warden overhead vs direct:
  passthrough      p50 +0.603ms   p99 +1.623ms
  full security    p50 +0.696ms   p99 +1.295ms
```

### Reading it

- **Median overhead is sub-millisecond (~0.6ms).** That's the cost of the extra
  stdio hop a gateway inherently adds.
- **The full security layer is nearly free on top of the proxy hop** — policy,
  rate limiting, tool screening, per-output prompt-injection scanning, and audit
  logging together add only ~0.1ms at p50 over bare passthrough. The heuristic
  detector is regex over a short string; it does not move the needle.
- **The tail (p99) is dominated by process/GC jitter**, not by Warden's logic —
  it varies run to run (note the one-off 15.8ms `max` on passthrough). Run more
  iterations for a tighter tail.

The upstream here does almost no work, which is deliberate: it maximizes the
*relative* visibility of Warden's overhead. Against a real tool that does I/O or
calls an API (tens to hundreds of ms), Warden's fixed ~0.6ms is in the noise.

## Conformance

The benchmark proves Warden is fast. Conformance proves it's still a correct MCP
server while proxying. Warden is verified against the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) — the
reference client — for `initialize`, `tools/list`, and `tools/call`. With a
`warden.config.yaml` in the working directory (see `examples/`):

```bash
# tools/list — the federated, namespaced catalog served through Warden
npx @modelcontextprotocol/inspector --cli node dist/cli.js --method tools/list

# tools/call — a round-tripped call, proxied to the upstream
npx @modelcontextprotocol/inspector --cli node dist/cli.js \
  --method tools/call --tool-name everything__echo --tool-arg "message=hello"
```
