# Warden

**A control plane for AI tool access.**

Warden is an open-source [MCP](https://modelcontextprotocol.io) gateway that sits between your MCP clients and your MCP servers, adding what individual servers lack:

- **Security** — tool-poisoning and prompt-injection detection, per-client/per-tool policy, rate limiting, approval gates for dangerous tools.
- **Observability** — OpenTelemetry traces for every tool call, structured JSONL audit logs, metrics.
- **Federation** — many MCP servers behind one endpoint, with a unified, namespaced tool catalog.

Backed by a published security-detection benchmark (precision/recall on a labeled corpus of malicious and benign tool definitions) and measured proxy-overhead numbers — not vibes.

## Status

> ⚠️ **Today:** Warden federates multiple MCP servers behind one gateway — a unified, per-server-namespaced tool catalog served over **stdio** and **Streamable HTTP**, with `tools/call` routed to the owning upstream (verified with MCP Inspector against `server-everything` + `server-filesystem`). Every tool call is **traced** (OpenTelemetry → OTLP), **audited** (structured JSONL), and **counted** (`/metrics`), and passes through a **security layer**: policy rules, rate limiting, approval gating, and a tool-poisoning/prompt-injection detector that quarantines malicious tool definitions and blocks injected tool outputs. Detection accuracy is not yet benchmarked — the published precision/recall eval is next on the roadmap. This README will only ever claim what currently works.

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

## Roadmap

- [x] **Passthrough proxy**: stdio MCP server ⇄ one real MCP server (`initialize`, `tools/list`, `tools/call`)
- [x] **Federation + Streamable HTTP**: many servers behind one endpoint, namespaced catalog, config-driven
- [x] **Observability**: OTel trace per tool call, JSONL audit log, metrics
- [x] **Security layer**: policy engine, rate limiting, tool-poisoning/injection detector (heuristic + LLM-judge tiers), approval gates
- [ ] **Security eval benchmark**: labeled corpus + scoring harness publishing precision/recall
- [ ] **Performance benchmark**: proxy overhead p50/p99, methodology committed
- [ ] **v0.1 release**: npm + Docker + Cloud Run reference deploy, auth, docs

## Planned architecture

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
