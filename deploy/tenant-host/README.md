# Docker tenant host

The tenant host operates several QM Docker deployments as one hosted platform. Each company retains its own core, Postgres database, secrets, identity provider, Slack installation, storage, Docker network, and nested sandbox daemon. A single Caddy gateway routes HTTPS hostnames to tenant portals, and a loopback-only admin service exposes tenant status, logs, start, stop, and gateway reconciliation.

Create one normal Docker deployment directory per company and give each one a distinct `orgId`, HTTPS `publicUrl`, and explicit `basePort`. Then create `qm.host.jsonc` beside those directories:

```json
{
  "contract": 1,
  "id": "production",
  "gateway": {
    "image": "caddy:2-alpine@sha256:<manifest-digest>",
    "email": "ops@example.com"
  },
  "tenants": [{ "config": "tenants/acme/qm.config.jsonc" }, { "config": "tenants/globex/qm.config.jsonc" }]
}
```

Each tenant must select the local sandbox backend and either a digest-pinned registry image or a bare local Docker image ID:

```json
{
  "sandbox": {
    "backend": "local",
    "image": "ghcr.io/example/qm-sandbox@sha256:<manifest-digest>"
  },
  "env": {
    "core": {
      "LOCAL_SANDBOX_CPUS": "1",
      "LOCAL_SANDBOX_MEMORY_MB": "1024"
    }
  }
}
```

For a single test host, build the sandbox agent image on that host and record its bare image ID in each tenant config:

```bash
npm run sandbox:local:build
docker image inspect qm-sandbox-local:latest --format '{{.Id}}'
```

The result has the form `sha256:<digest>`. Use that exact value as `sandbox.image`, without an image name or `@`. The controller copies the local image into every tenant's nested daemon.

For a portable deployment, push the image to a public registry and record its immutable registry digest instead:

```bash
npm run sandbox:local:build
docker tag qm-sandbox-local:latest ghcr.io/example/qm-sandbox:2026-08-18
docker push ghcr.io/example/qm-sandbox:2026-08-18
docker buildx imagetools inspect ghcr.io/example/qm-sandbox:2026-08-18
```

The nested daemons pull registry-digest images directly and do not currently receive private-registry credentials, so a recorded registry image must be anonymously pullable. Bare local image IDs are loaded from the host Docker image store and therefore do not use a registry.

First-party service images follow the same rule. Published deployments pin registry digests in `imageOverrides`; a single test host can build every configured service from the checkout and then pin the resulting local IDs:

```bash
docker compose -f deploy/tenant-host/compose.yml run --rm host \
  node /app/cli/bin/qm.ts host up "$QM_TENANT_ROOT/qm.host.jsonc" --build-from "$QM_SOURCE_ROOT"

for service in core web-ui admin portal auth slack; do
  docker image inspect "qm-$service:local" --format "\"$service\": \"{{.Id}}\"" 2>/dev/null || true
done
```

Record the lines for the tenant's configured services in its `imageOverrides`. Later ordinary `host up` operations use those immutable local IDs without rebuilding or contacting a registry.

To enable Tlon for a tenant, add the bundled sidecar as an image plugin:

```json
{
  "plugins": [
    {
      "name": "tlon",
      "image": "sha256:<local-image-id>"
    }
  ]
}
```

Build it with the rest of a local deployment:

```bash
docker compose -f deploy/tenant-host/compose.yml run --rm host \
  node /app/cli/bin/qm.ts host up "$QM_TENANT_ROOT/qm.host.jsonc" --build-from "$QM_SOURCE_ROOT"

docker image inspect qm-tlon:local --format '{{.Id}}'
```

Record that exact local image ID as the plugin image before subsequent ordinary `host up` operations. For the first source build, the plugin entry still needs a syntactically valid immutable image value; `--build-from` replaces it with the bundled `deploy/tlon/Dockerfile` build. A published deployment can instead pin the release's `ghcr.io/yc-software/qm/tlon@sha256:<digest>` image.

After the operator installs the plugin once, each signed-in user connects their own bot ship under **Web UI → Keychain → Tlon** with its URL, login code, and their owner ship. Login codes are encrypted in that tenant's Postgres database and never displayed again. One `qm-<tenant>-tlon` sidecar connects outward to every user-owned account in that tenant; neither the host operator nor the configured ships need another sidecar.

The host loads that image into a dedicated nested Docker daemon for each tenant. Tenant cores never receive the host Docker socket or another tenant's daemon endpoint. The daemon requires mutual TLS, and only that tenant's core receives the client certificate; agent containers can reach the daemon network address but cannot authenticate to its API. Agent execution endpoints require unique per-container bearer credentials derived from a tenant-scoped secret. Sandbox daemon state, certificates, and the credential root are retained in tenant-scoped durable state.

The gateway image must be pinned by manifest digest. Resolve the chosen official Caddy image before recording it:

```bash
docker buildx imagetools inspect caddy:2-alpine
```

Use either the top-level OCI index digest or the child manifest whose platform matches the host. Do not use an `unknown/unknown` child: those entries are attestations rather than runnable images. For an AMD64 host, select the `linux/amd64` child shown by the command.

Validate and preview the entire host without changing Docker:

```bash
qm host check
qm host plan
qm host render
```

Bring up every tenant and reconcile the gateway:

```bash
qm host up
qm host status
```

The gateway uses Linux host networking, binds ports 80 and 443, and proxies to tenant portal ports bound on `127.0.0.1`. Caddy state persists in Docker volumes. The generated Caddyfile lives under `.qm-host/`; add that directory to the host repository's ignore file.

The admin API and frontend bind to `127.0.0.1:9080` and require a bearer token of at least 32 characters. Reach them through an SSH tunnel:

```bash
export QM_HOST_ADMIN_TOKEN="$(openssl rand -hex 32)"
qm host serve
ssh -L 9080:127.0.0.1:9080 <host>
```

To run the controller itself as a container, mount the tenant root at the same absolute path inside the container. Docker interprets tenant bind-mount paths on the host, so changing the path inside the controller breaks layer mounts. Persist the controller's QM state because it contains the generated local Postgres passwords.

The included Compose deployment handles these mounts:

```bash
export QM_SOURCE_ROOT=/path/to/qm
export QM_TENANT_ROOT=/srv/qm-host
export QM_HOST_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose -f deploy/tenant-host/compose.yml up -d --build
```

```bash
docker build -f deploy/tenant-host/Dockerfile -t qm-tenant-host .
docker run -d \
  --name qm-tenant-host \
  --network host \
  --restart unless-stopped \
  -e QM_HOST_ADMIN_TOKEN \
  -e XDG_CONFIG_HOME=/var/lib/qm-host/config \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /path/to/qm:/path/to/qm:ro \
  -v /srv/qm-host:/srv/qm-host \
  -v qm-tenant-host-state:/var/lib/qm-host \
  -w /srv/qm-host \
qm-tenant-host
```

Run tenant lifecycle operations through this controller or use the same persisted `XDG_CONFIG_HOME`; mixing it with a host CLI that has a different state directory bypasses the shared deployment lock.

Anyone controlling the host admin service controls the Docker daemon and every tenant on that machine. Keep it on loopback, use an SSH tunnel, use a dedicated host, and do not publish port 9080 through the customer gateway.

This layout gives each company separate application containers, networks, databases, volumes, and nested sandbox daemons. The controller still owns the host Docker socket, and the sandbox daemons run in privileged outer containers. Treat the Linux host and controller as one administrative trust domain. Local agent containers do not enforce an egress allowlist, and the CPU/memory settings are per agent rather than aggregate tenant quotas. Apply host-level capacity monitoring and firewall policy. Use a separate VM or host per company when the companies themselves can run untrusted platform extensions or when contractual isolation requires a hypervisor boundary.
