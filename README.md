# Warden

**A control plane for AI tool access.**

Warden is an open-source [MCP](https://modelcontextprotocol.io) gateway that sits between your MCP clients and your MCP servers, adding what individual servers lack:

- **Security** — tool-poisoning and prompt-injection detection, per-client/per-tool policy, rate limiting, approval gates for dangerous tools.
- **Observability** — OpenTelemetry traces for every tool call, structured JSONL audit logs, metrics.
- **Federation** — many MCP servers behind one endpoint, with a unified, namespaced tool catalog.

Backed by a published security-detection benchmark (precision/recall on a labeled corpus of malicious and benign tool definitions) and measured proxy-overhead numbers — not vibes.

## Status

> ⚠️ **Today:** Warden federates multiple MCP servers behind one gateway — a unified, per-server-namespaced tool catalog served over **stdio** and **Streamable HTTP**, with `tools/call` routed to the owning upstream (verified with MCP Inspector against `server-everything` + `server-filesystem`). Every tool call is **traced** (OpenTelemetry → OTLP), **audited** (structured JSONL), and **counted** (`/metrics`). No security layer yet. This README will only ever claim what currently works — follow the roadmap below.

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
- [ ] **Security layer**: policy engine, rate limiting, tool-poisoning/injection detector (heuristic + LLM-judge tiers), approval gates
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
