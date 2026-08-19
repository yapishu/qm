import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, runInherit } from "../util.ts";
import { CliError, header, note, ok, step } from "../log.ts";
import { runChecks } from "../commands/check.ts";
import { hostingProvider, type DeployContext } from "../backends/registry.ts";
import {
  loadTenantHostConfig,
  renderTenantHostCaddyfile,
  tenantHostStateDir,
  type TenantHostConfig,
  type TenantHostTenant,
} from "./config.ts";

export interface TenantServiceStatus {
  name: string;
  state: string;
  detail: string;
}

export interface TenantStatus {
  orgId: string;
  hostname: string;
  publicUrl: string;
  configPath: string;
  services: TenantServiceStatus[];
  running: boolean;
}

export interface TenantHostStatus {
  id: string;
  gateway: { name: string; running: boolean; detail: string };
  tenants: TenantStatus[];
}

const gatewayName = (host: TenantHostConfig): string => `qm-host-${host.id}-gateway`;
const gatewayDataVolume = (host: TenantHostConfig): string => `qm-host-${host.id}-caddy-data`;
const gatewayConfigVolume = (host: TenantHostConfig): string => `qm-host-${host.id}-caddy-config`;

function tenantContext(tenant: TenantHostTenant): DeployContext {
  return {
    config: tenant.config,
    configPath: tenant.configPath,
    configDir: tenant.configDir,
    sandboxDir: tenant.sandboxDir,
    envFile: tenant.envFile,
    target: "docker",
    isolateProcessEnv: true,
  };
}

function requireHostDocker(): void {
  try {
    capture("docker", ["version", "-f", "{{.Server.Version}}"]).trim();
  } catch {
    throw new CliError("the Docker daemon is not reachable");
  }
  if (process.platform !== "linux") throw new CliError("tenant host gateway networking requires Linux");
  if (process.env.QM_BASE_PORT) {
    throw new CliError("QM_BASE_PORT must be unset for tenant hosting; each tenant config owns its explicit basePort");
  }
}

export function checkTenantHost(host: TenantHostConfig): void {
  if (process.env.QM_BASE_PORT) {
    throw new CliError("QM_BASE_PORT must be unset for tenant hosting; each tenant config owns its explicit basePort");
  }
  for (const tenant of host.tenants) {
    runChecks(tenant.config, tenant.configDir, tenant.sandboxDir, { report: false });
  }
}

export async function upTenant(
  tenant: TenantHostTenant,
  opts: { dryRun?: boolean; buildFrom?: string } = {},
): Promise<void> {
  runChecks(tenant.config, tenant.configDir, tenant.sandboxDir, { report: false });
  const ctx = tenantContext(tenant);
  await hostingProvider("docker")
    .createBackend(ctx)
    .up({
      dryRun: opts.dryRun ?? false,
      buildFrom: opts.buildFrom !== undefined,
      ...(opts.buildFrom ? { buildFromPath: opts.buildFrom } : {}),
    });
}

export async function downTenant(tenant: TenantHostTenant): Promise<void> {
  await hostingProvider("docker").createBackend(tenantContext(tenant)).down({ purge: false });
}

export function renderTenantHost(host: TenantHostConfig): string {
  return renderTenantHostCaddyfile(host);
}

export function reconcileTenantGateway(host: TenantHostConfig): void {
  requireHostDocker();
  const stateDir = tenantHostStateDir(host);
  mkdirSync(stateDir, { recursive: true });
  const caddyfile = join(stateDir, "Caddyfile");
  writeFileSync(caddyfile, renderTenantHostCaddyfile(host), { mode: 0o600 });
  step(`pulling ${host.gateway.image}`);
  runInherit("docker", ["pull", host.gateway.image]);
  capture("docker", ["rm", "-f", gatewayName(host)], { allow: /No such container|No such object/i });
  const result = capture("docker", [
    "run",
    "-d",
    "--name",
    gatewayName(host),
    "--label",
    `qm.host=${host.id}`,
    "--network",
    "host",
    "--restart",
    "unless-stopped",
    "-v",
    `${caddyfile}:/etc/caddy/Caddyfile:ro`,
    "-v",
    `${gatewayDataVolume(host)}:/data`,
    "-v",
    `${gatewayConfigVolume(host)}:/config`,
    host.gateway.image,
  ]).trim();
  if (!result) throw new CliError("tenant gateway did not return a container id");
  const running = capture("docker", ["inspect", "-f", "{{.State.Running}}", gatewayName(host)]).trim();
  if (running !== "true") throw new CliError(`tenant gateway ${gatewayName(host)} did not stay running`);
  ok(`gateway ready for ${host.tenants.length} tenants`);
}

export async function upTenantHost(
  host: TenantHostConfig,
  opts: { dryRun?: boolean; buildFrom?: string } = {},
): Promise<void> {
  if (!opts.dryRun) requireHostDocker();
  checkTenantHost(host);
  header(`qm host ${opts.dryRun ? "plan" : "up"} — ${host.id}`);
  for (const tenant of host.tenants) {
    step(`${opts.dryRun ? "planning" : "reconciling"} ${tenant.config.orgId}`);
    await upTenant(tenant, opts);
  }
  if (opts.dryRun) {
    note("\nGateway Caddyfile:\n");
    note(renderTenantHostCaddyfile(host));
    return;
  }
  reconcileTenantGateway(host);
  ok(`tenant host up — ${host.id}`);
}

export async function downTenantHost(host: TenantHostConfig): Promise<void> {
  requireHostDocker();
  capture("docker", ["rm", "-f", gatewayName(host)], { allow: /No such container|No such object/i });
  for (const tenant of [...host.tenants].reverse()) await downTenant(tenant);
  ok(`tenant host down — ${host.id}; data volumes preserved`);
}

function serviceStatus(orgId: string): TenantServiceStatus[] {
  const prefix = `qm-${orgId}-`;
  const raw = capture("docker", [
    "ps",
    "-a",
    "--filter",
    `label=qm.org=${orgId}`,
    "--format",
    "{{.Names}}\t{{.State}}\t{{.Status}}",
  ]).trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      const [name = "", state = "unknown", detail = ""] = line.split("\t");
      return { name, state, detail };
    })
    .filter((service) => service.name.startsWith(prefix));
}

function gatewayStatus(host: TenantHostConfig): TenantHostStatus["gateway"] {
  const name = gatewayName(host);
  const raw = capture("docker", ["inspect", "-f", "{{.State.Running}}\t{{.State.Status}}", name], {
    allow: /No such object|No such container/i,
  }).trim();
  if (!raw || /No such object|No such container/i.test(raw)) return { name, running: false, detail: "missing" };
  const [running, detail = "unknown"] = raw.split("\t");
  return { name, running: running === "true", detail };
}

export function tenantHostStatus(host: TenantHostConfig): TenantHostStatus {
  requireHostDocker();
  return {
    id: host.id,
    gateway: gatewayStatus(host),
    tenants: host.tenants.map((tenant) => {
      const services = serviceStatus(tenant.config.orgId);
      return {
        orgId: tenant.config.orgId,
        hostname: tenant.hostname,
        publicUrl: tenant.config.publicUrl,
        configPath: tenant.configPath,
        services,
        running: ["core", "portal"].every((name) =>
          services.some(
            (service) => service.name === `qm-${tenant.config.orgId}-${name}` && service.state === "running",
          ),
        ),
      };
    }),
  };
}

export function findTenant(host: TenantHostConfig, orgId: string): TenantHostTenant {
  const tenant = host.tenants.find((candidate) => candidate.config.orgId === orgId);
  if (!tenant) throw new CliError(`unknown tenant ${JSON.stringify(orgId)}`);
  return tenant;
}

export function loadHost(path?: string): TenantHostConfig {
  return loadTenantHostConfig(path);
}
