# Warden on Cloud Run (reference deploy)

Terraform for a minimal, production-shaped Warden deployment on Google Cloud Run:

- Cloud Run v2 service running the Warden image in **HTTP mode**, scale-to-zero.
- Gateway config delivered via **Secret Manager**, mounted read-only at
  `/etc/warden/warden.config.yaml` — no config baked into the image.
- **API keys** injected as `WARDEN_API_KEYS` from a second secret; every
  `/mcp` and `/metrics` request must present `Authorization: Bearer <key>`.
- Dedicated **service account** with access to exactly those two secrets and
  nothing else.
- Startup probe on `/healthz` with headroom for `npx`-declared upstream servers
  to download on first boot.

## Deploy

```bash
# 1. Build and push the image to Artifact Registry (Cloud Run can't pull from
#    other registries directly):
gcloud artifacts repositories create warden --repository-format=docker \
  --location=us-central1
docker build -t us-central1-docker.pkg.dev/$PROJECT/warden/mcp-warden:0.1.0 .
docker push us-central1-docker.pkg.dev/$PROJECT/warden/mcp-warden:0.1.0

# 2. Deploy
cd deploy/cloudrun
terraform init
terraform apply \
  -var project_id=$PROJECT \
  -var image=us-central1-docker.pkg.dev/$PROJECT/warden/mcp-warden:0.1.0 \
  -var api_keys=$(openssl rand -hex 24)

# 3. Point an MCP client at it
npx @modelcontextprotocol/inspector --cli "$(terraform output -raw url)/mcp" \
  --transport http --header "Authorization: Bearer <your-key>" --method tools/list
```

## Notes

- The default config is [`examples/warden.config.docker.yaml`](../../examples/warden.config.docker.yaml);
  point `-var config_file=...` at your own. The config must listen on
  `host: 0.0.0.0`, port `3000`.
- Cloud Run IAM is left open (`allow_unauthenticated = true`) because Warden
  enforces its own Bearer-key auth; set it to `false` to require Google IAM on
  top.
- Upstream MCP servers run **inside the same container** (spawned over stdio),
  so they scale with the service. For heavyweight upstreams, bake them into a
  derived image instead of downloading via `npx` at cold start.
- Audit logs written to `/tmp` are per-instance and ephemeral — ship them via
  OTLP (`observability.otlpEndpoint`) or mount a GCS volume if you need them
  durable.
