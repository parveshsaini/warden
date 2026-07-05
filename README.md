# Warden

**A control plane for AI tool access.**

Warden is an open-source [MCP](https://modelcontextprotocol.io) gateway that sits between your MCP clients and your MCP servers, adding what individual servers lack:

- **Security** — tool-poisoning and prompt-injection detection, per-client/per-tool policy, rate limiting, approval gates for dangerous tools.
- **Observability** — OpenTelemetry traces for every tool call, structured JSONL audit logs, metrics.
- **Federation** — many MCP servers behind one endpoint, with a unified, namespaced tool catalog.

Backed by a published security-detection benchmark (precision/recall on a labeled corpus of malicious and benign tool definitions) and measured proxy-overhead numbers — not vibes.

## Status

> ⚠️ **Today:** Warden federates multiple MCP servers behind one gateway — a unified, per-server-namespaced tool catalog served over **stdio** and **Streamable HTTP**, with `tools/call` routed to the owning upstream (verified with MCP Inspector against `server-everything` + `server-filesystem`). Every tool call is **traced** (OpenTelemetry → OTLP), **audited** (structured JSONL), and **counted** (`/metrics`), and passes through a **security layer**: policy rules, rate limiting, approval gating, and a tool-poisoning/prompt-injection detector that quarantines malicious tool definitions and blocks injected tool outputs. Detection accuracy is measured by a committed, reproducible benchmark — **93.5% precision / 87.8% recall (F1 90.5%)** on a labeled corpus of 93 tool definitions, offline heuristic tier, via `pnpm eval` (see [`evals/`](evals/)). HTTP mode supports **Bearer API-key auth**; upstream requests get per-server **timeouts** (and retries for idempotent listing, never for tool calls). Proxy overhead is measured too — **~0.6ms median** added latency, security layer nearly free on top (`pnpm bench`, see [`bench/`](bench/)). Ships as a **Docker image** ([`Dockerfile`](Dockerfile), [compose example](examples/docker-compose.yaml)) with a **Terraform Cloud Run reference deploy** ([`deploy/cloudrun/`](deploy/cloudrun/)). This README will only ever claim what currently works.

## Quick start (dev)

```bash
pnpm install && pnpm build

# warden.config.yaml — see examples/warden.config.yaml
# servers:
#   - name: everything
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-everything"]
#   - name: fs
#     command: npx
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]

# stdio (default) — tools appear as everything__echo, fs__read_file, ...
npx @modelcontextprotocol/inspector --cli node dist/cli.js \
  --method tools/call --tool-name everything__echo --tool-arg "message=hi"

# Streamable HTTP
node dist/cli.js --http   # serves http://127.0.0.1:3000/mcp
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
```

In HTTP mode, set `http.auth.apiKeys` in the config (or the `WARDEN_API_KEYS` env var, comma-separated) to require `Authorization: Bearer <key>` on `/mcp` and `/metrics` — `/healthz` stays open for probes. Warden warns at startup if it's listening beyond loopback with no keys. Each upstream gets a per-request `timeoutMs` (default 30s) and a `retries` budget applied to `tools/list` only — `tools/call` is deliberately never replayed, because tool calls can have side effects.

## Security

Add a `security` block to `warden.config.yaml` (every part optional):

```yaml
security:
  policy:
    defaultAction: allow            # or deny (allowlist mode)
    rules:                          # first match wins; "*" wildcards
      - action: deny
        tools: ["fs__delete_*", "everything__get-env"]
        # clients: ["cursor*"]      # optionally scope a rule to MCP client names
  rateLimit:
    callsPerMinute: 120             # token bucket, shared per gateway process
  detector:
    tier: heuristic                 # "heuristic" (no API key) or "llm" (adds a
                                    # Claude judge via ANTHROPIC_API_KEY)
    scanDescriptions: true          # quarantine poisoned tool definitions
    scanOutputs: true               # block prompt injection in tool results
    mode: block                     # or "warn" to only audit
  approval:
    tools: ["fs__write_*"]          # require approval per call; fails closed
                                    # unless an approval handler is wired in
```

What the detector catches (heuristic tier — rule-based, offline): hidden instruction tags (`<IMPORTANT>`-style tool poisoning), instruction overrides, concealment ("don't tell the user"), sensitive-file access lures (`~/.ssh`, `.env`, ...), exfiltration to external URLs, cross-tool shadowing, invisible Unicode, and encoded payloads. The `llm` tier escalates anything the rules don't conclusively flag to a Claude model for a second opinion, and degrades gracefully to the heuristic result if the API is unavailable.

A quarantined tool disappears from the federated catalog and calls to it are rejected — here against this repo's poisoned fixture server (`test/fixtures/poisoned-server.mjs`, upstream name `px`):

```
$ npx @modelcontextprotocol/inspector --cli node dist/cli.js \
    --method tools/call --tool-name px__get_weather --tool-arg city=Berlin
MCP error -32600: [warden] tool "px__get_weather" is quarantined
  (flagged: concealment, hidden-tag, sensitive-file, tool-shadowing)
```

Every denial lands in the audit log with a `denyReason` (`policy`, `rate_limit`, `approval`, `poisoned_tool`, `poisoned_output`).

### How good is the detector?

Not a claim — a number. [`evals/`](evals/) holds a committed corpus of 93 labeled tool definitions (malicious tool-poisoning/injection/exfiltration/credential-theft plus realistic benign tools that legitimately mention files, URLs, and secrets) and a harness that scores the detector. Reproduce with `pnpm eval`:

```
Blocking decision (verdict = malicious -> quarantined):
  precision: 93.5%   (43/46 flagged were truly malicious)
  recall:    87.8%   (43/49 malicious tools blocked)
  F1:        90.5%
```

That's the offline heuristic tier — no API key. The corpus intentionally includes keyword-free semantic attacks the rules are *not* expected to catch (they're the case for the LLM-judge tier), and the harness prints every false positive and false negative by id. See [`evals/README.md`](evals/README.md) for the data format and methodology.

## Observability

Add to `warden.config.yaml` (all optional — zero overhead when off):

```yaml
observability:
  # every tool call becomes a trace: gateway span -> upstream child span
  otlpEndpoint: http://localhost:4318   # or set OTEL_EXPORTER_OTLP_ENDPOINT
  audit:
    path: warden-audit.jsonl            # structured JSONL audit trail
    includeArguments: false             # arguments redacted by default
```

Audit entry per tool call:

```json
{"event":"tools/call","tool":"fs__read_text_file","server":"fs","outcome":"ok","durationMs":13.13,...}
```

In HTTP mode, `GET /metrics` returns per-tool call/error counts and latency; `GET /healthz` reports upstream status.

## Performance

What does putting Warden in front of a server cost? [`bench/`](bench/) measures it — the same tool called directly vs through Warden, so the delta is pure gateway overhead. Reproduce with `pnpm bench`:

```
path                          p50      p90      p99
------------------------------------------------------
direct (no gateway)       0.513ms  0.772ms  1.487ms
warden (passthrough)      1.115ms  1.596ms  3.110ms
warden (full security)    1.208ms  1.616ms  2.782ms
```

**Median overhead is ~0.6ms** — the cost of the extra stdio hop a gateway inherently adds. The **full security layer** (policy + rate limit + tool screening + per-output injection scanning + audit) adds only **~0.1ms** on top of bare passthrough: the detection work is nearly free next to the IPC hop. Against a real tool that does I/O (tens to hundreds of ms), Warden's fixed cost is in the noise. Absolute numbers are machine-dependent — see [`bench/README.md`](bench/README.md) for the method (interleaved paths, warmup, fixed payload) and the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) conformance check.

## Deploy

**Docker** — multi-stage [`Dockerfile`](Dockerfile) (Node 22 slim, non-root, prod deps only). Run it with the [compose example](examples/docker-compose.yaml):

```bash
WARDEN_API_KEYS=$(openssl rand -hex 24) docker compose -f examples/docker-compose.yaml up
# MCP endpoint: http://localhost:3000/mcp  (Authorization: Bearer <key>)
```

Upstream MCP servers declared in the config run inside the same container, spawned over stdio.

**Cloud Run** — [`deploy/cloudrun/`](deploy/cloudrun/) is a Terraform reference deploy: scale-to-zero Cloud Run v2 service, config and API keys delivered via Secret Manager, dedicated service account, `/healthz` startup probe. See its [README](deploy/cloudrun/README.md).

## Roadmap

- [x] **Passthrough proxy**: stdio MCP server ⇄ one real MCP server (`initialize`, `tools/list`, `tools/call`)
- [x] **Federation + Streamable HTTP**: many servers behind one endpoint, namespaced catalog, config-driven
- [x] **Observability**: OTel trace per tool call, JSONL audit log, metrics
- [x] **Security layer**: policy engine, rate limiting, tool-poisoning/injection detector (heuristic + LLM-judge tiers), approval gates
- [x] **Security eval benchmark**: labeled corpus + scoring harness publishing precision/recall
- [x] **Performance benchmark**: proxy overhead p50/p99, methodology committed
- [ ] **v0.1 release**: npm + Docker + Cloud Run reference deploy, auth, docs

## Architecture

```
MCP client (Claude, Cursor, ...)
        │  stdio / Streamable HTTP
        ▼
   ┌─────────┐   policy · detector · rate limit · audit · traces
   │ Warden  │
   └─────────┘
    │   │   │    stdio / Streamable HTTP
    ▼   ▼   ▼
   MCP servers (filesystem, github, internal tools, ...)
```

## License

[MIT](LICENSE)
