# Warden

**A control plane for AI tool access.**

Warden is an open-source [MCP](https://modelcontextprotocol.io) gateway that sits between your MCP clients and your MCP servers, adding what individual servers lack:

- **Security** — tool-poisoning and prompt-injection detection, per-client/per-tool policy, rate limiting, approval gates for dangerous tools.
- **Observability** — OpenTelemetry traces for every tool call, structured JSONL audit logs, metrics.
- **Federation** — many MCP servers behind one endpoint, with a unified, namespaced tool catalog.

Backed by a published security-detection benchmark (precision/recall on a labeled corpus of malicious and benign tool definitions) and measured proxy-overhead numbers — not vibes.

## Status

> ⚠️ **Today:** repository scaffold only. Nothing is proxied yet. This README will only ever claim what currently works — follow the roadmap below.

## Roadmap

- [x] **C0 — Repo scaffold**: TypeScript strict, pnpm, vitest, Biome, CI
- [ ] **C1 — Passthrough proxy**: stdio MCP server ⇄ one real MCP server (`initialize`, `tools/list`, `tools/call`)
- [ ] **C2 — Federation + Streamable HTTP**: ≥2 servers behind one endpoint, namespaced catalog, config-driven
- [ ] **C3 — Observability**: OTel trace per tool call, JSONL audit log, metrics
- [ ] **C4 — Security layer**: policy engine, rate limiting, tool-poisoning/injection detector (heuristic + LLM-judge tiers), approval gates
- [ ] **C5 — Security eval benchmark**: labeled corpus + scoring harness publishing precision/recall
- [ ] **C6 — Perf benchmark**: proxy overhead p50/p99, methodology committed
- [ ] **C7 — Ship**: npm + Docker + Cloud Run reference deploy, auth, docs

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
