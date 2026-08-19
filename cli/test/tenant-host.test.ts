import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_CONFIG_FILENAME, loadTenantHostConfig, renderTenantHostCaddyfile } from "../src/host/config.ts";
import { serveTenantHostAdmin } from "../src/host/admin.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;

function tenant(dir: string, orgId: string, hostname: string, basePort: number): string {
  const tenantDir = join(dir, "tenants", orgId);
  mkdirSync(tenantDir, { recursive: true });
  writeFileSync(join(tenantDir, ".env"), "");
  const path = join(tenantDir, "qm.config.jsonc");
  writeFileSync(
    path,
    JSON.stringify({
      contract: 1,
      orgId,
      publicUrl: `https://${hostname}`,
      target: "docker",
      basePort,
      services: ["core", "portal"],
      sandbox: { backend: "local", image: `ghcr.io/example/qm-sandbox@${DIGEST}` },
      env: { core: { HARNESS: "mock" } },
    }),
  );
  return path;
}

function hostFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-tenant-host-"));
  tenant(dir, "acme", "acme.example.com", 18080);
  tenant(dir, "globex", "globex.example.com", 18180);
  const path = join(dir, HOST_CONFIG_FILENAME);
  writeFileSync(
    path,
    JSON.stringify({
      contract: 1,
      id: "production",
      gateway: { image: `caddy:2-alpine@${DIGEST}`, email: "ops@example.com" },
      tenants: [{ config: "tenants/acme/qm.config.jsonc" }, { config: "tenants/globex/qm.config.jsonc" }],
    }),
  );
  return { dir, path };
}

test("tenant host loads isolated Docker deployments and renders hostname routes", () => {
  const fixture = hostFixture();
  try {
    const host = loadTenantHostConfig(fixture.path);
    assert.equal(host.id, "production");
    assert.deepEqual(
      host.tenants.map((entry) => [entry.config.orgId, entry.hostname, entry.portalPort]),
      [
        ["acme", "acme.example.com", 18081],
        ["globex", "globex.example.com", 18181],
      ],
    );
    assert.equal(
      renderTenantHostCaddyfile(host),
      "{\n\tadmin off\n\temail ops@example.com\n}\n\nacme.example.com {\n\treverse_proxy 127.0.0.1:18081\n}\n\nglobex.example.com {\n\treverse_proxy 127.0.0.1:18181\n}\n",
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tenant host rejects overlapping service ports and mutable gateway images", () => {
  const fixture = hostFixture();
  try {
    tenant(fixture.dir, "globex", "globex.example.com", 18079);
    assert.throws(() => loadTenantHostConfig(fixture.path), /service port 18080 is allocated twice/);
    tenant(fixture.dir, "globex", "globex.example.com", 18180);
    const raw = JSON.parse(readFileSync(fixture.path, "utf8")) as { gateway: { image: string } };
    raw.gateway.image = "caddy:2-alpine";
    writeFileSync(fixture.path, JSON.stringify(raw));
    assert.throws(() => loadTenantHostConfig(fixture.path), /immutable image reference/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tenant host accepts immutable local images and rejects mutable image tags", () => {
  const fixture = hostFixture();
  try {
    const configPath = join(fixture.dir, "tenants", "acme", "qm.config.jsonc");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { sandbox: { image: string } };
    raw.sandbox.image = DIGEST;
    writeFileSync(configPath, JSON.stringify(raw));
    assert.equal(loadTenantHostConfig(fixture.path).tenants[0]?.config.sandbox?.image, DIGEST);
    raw.sandbox.image = "qm-sandbox-local:latest";
    writeFileSync(configPath, JSON.stringify(raw));
    assert.throws(() => loadTenantHostConfig(fixture.path), /registry digest.*local Docker image ID/);
    raw.sandbox.image = DIGEST;
    const withOverrides = raw as typeof raw & { imageOverrides: { core: string } };
    withOverrides.imageOverrides = { core: DIGEST };
    writeFileSync(configPath, JSON.stringify(withOverrides));
    assert.equal(loadTenantHostConfig(fixture.path).tenants[0]?.config.imageOverrides.core, DIGEST);
    withOverrides.imageOverrides.core = "qm-core:latest";
    writeFileSync(configPath, JSON.stringify(withOverrides));
    assert.throws(() => loadTenantHostConfig(fixture.path), /imageOverrides\.core.*registry digest/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tenant host rejects controller ports and allocations beyond the TCP range", () => {
  const fixture = hostFixture();
  try {
    tenant(fixture.dir, "acme", "acme.example.com", 9079);
    assert.throws(() => loadTenantHostConfig(fixture.path), /service port 9080 is reserved/);
    tenant(fixture.dir, "acme", "acme.example.com", 65535);
    assert.throws(() => loadTenantHostConfig(fixture.path), /service port 65536 is outside/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tenant host plans ignore ambient deployment database settings", () => {
  const fixture = hostFixture();
  try {
    const result = spawnSync(process.execPath, ["bin/qm.ts", "host", "plan", fixture.path], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgres://ambient.example/shared",
        CORE_SIGNING_SECRET: "ambient-controller-secret-that-must-not-be-used",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /using DATABASE_URL from the environment/);
    assert.equal(output.match(/Postgres: would run/g)?.length, 2);
    assert.match(output, /MISSING required secrets.*CORE_SIGNING_SECRET/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test("tenant host admin serves its UI and protects operator APIs with a bearer token", async () => {
  const fixture = hostFixture();
  const bin = join(fixture.dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nif [ "$1" = "version" ]; then echo "27.0"; exit 0; fi\nif [ "$1" = "ps" ]; then printf "qm-acme-core\\trunning\\tUp 2 minutes\\nqm-acme-portal\\trunning\\tUp 2 minutes\\n"; exit 0; fi\nif [ "$1" = "inspect" ]; then echo "false\texited"; exit 0; fi\nif [ "$1" = "logs" ]; then echo "core ready"; exit 0; fi\nexit 0\n',
  );
  chmodSync(join(bin, "docker"), 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath ?? ""}`;
  const port = await freePort();
  const token = "host-admin-token-that-is-long-enough";
  const server = await serveTenantHostAdmin(loadTenantHostConfig(fixture.path), {
    listen: `127.0.0.1:${port}`,
    token,
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Tenant host/);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const status = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    const body = (await status.json()) as { id: string; tenants: Array<{ orgId: string; running: boolean }> };
    assert.equal(body.id, "production");
    assert.deepEqual(
      body.tenants.map((entry) => entry.orgId),
      ["acme", "globex"],
    );
    assert.equal(body.tenants[0]?.running, true);
    assert.equal(body.tenants[1]?.running, false);
    const logs = await fetch(`${base}/api/tenants/acme/logs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await logs.json(), { logs: "core ready\n" });
    tenant(fixture.dir, "acme", "acme.example.com", port);
    const conflict = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(conflict.status, 400);
    assert.match(((await conflict.json()) as { error: string }).error, /conflicts with a tenant service/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    process.env.PATH = priorPath;
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("tenant host admin rejects a listen port allocated to a tenant", async () => {
  const fixture = hostFixture();
  try {
    await assert.rejects(
      serveTenantHostAdmin(loadTenantHostConfig(fixture.path), {
        listen: "127.0.0.1:18080",
        token: "host-admin-token-that-is-long-enough",
      }),
      /conflicts with a tenant service/,
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
