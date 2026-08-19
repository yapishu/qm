import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDigestPinned, loadConfigAt, parseJsonc, validOrgId, type QmConfig } from "../config.ts";
import { CliError, errMessage } from "../log.ts";
import { runnableServices, serviceDef } from "../services.ts";

export const HOST_CONFIG_FILENAME = "qm.host.jsonc";

export interface TenantHostTenant {
  config: QmConfig;
  configPath: string;
  configDir: string;
  envFile: string;
  sandboxDir: string;
  hostname: string;
  portalPort: number;
  exposedPorts: number[];
}

export interface TenantHostConfig {
  contract: 1;
  id: string;
  path: string;
  dir: string;
  gateway: {
    image: string;
    email?: string;
  };
  tenants: TenantHostTenant[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new CliError(`${path}: unknown field ${JSON.stringify(unknown[0])}`);
}

function tenantOf(raw: unknown, index: number, hostDir: string): TenantHostTenant {
  const field = `tenants[${index}]`;
  if (!object(raw)) throw new CliError(`${field} must be an object`);
  allowedKeys(raw, ["config", "envFile", "sandboxDir"], field);
  if (typeof raw.config !== "string" || !raw.config.trim()) {
    throw new CliError(`${field}.config must be a non-empty path`);
  }
  const configPath = resolve(hostDir, raw.config);
  const loaded = loadConfigAt(configPath);
  if (loaded.config.target !== "docker") {
    throw new CliError(`${configPath}: tenant host deployments must use target "docker"`);
  }
  if (!loaded.config.services.includes("portal")) {
    throw new CliError(`${configPath}: tenant host deployments must include the portal service`);
  }
  if (loaded.config.basePort === undefined) {
    throw new CliError(`${configPath}: tenant host deployments must set an explicit basePort`);
  }
  if (loaded.config.sandbox?.backend !== "local") {
    throw new CliError(`${configPath}: tenant host deployments must set sandbox.backend to "local"`);
  }
  if (!loaded.config.sandbox.image || !isDigestPinned(loaded.config.sandbox.image)) {
    throw new CliError(`${configPath}: tenant host sandbox.image must be an immutable image reference`);
  }
  const publicUrl = new URL(loaded.config.publicUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.port || publicUrl.pathname !== "/") {
    throw new CliError(`${configPath}: tenant host publicUrl must be an HTTPS origin on the default port`);
  }
  if (
    publicUrl.hostname.length > 253 ||
    !publicUrl.hostname
      .split(".")
      .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new CliError(`${configPath}: tenant host publicUrl must use a lowercase DNS hostname`);
  }
  const configDir = dirname(loaded.path);
  const envFile = resolve(configDir, typeof raw.envFile === "string" ? raw.envFile : ".env");
  const sandboxDir = resolve(configDir, typeof raw.sandboxDir === "string" ? raw.sandboxDir : "sandbox");
  const exposedPorts = runnableServices(loaded.config.services).flatMap((service) => {
    const offset = serviceDef(service).docker.hostPortOffset;
    return offset === undefined ? [] : [loaded.config.basePort! + offset];
  });
  return {
    config: loaded.config,
    configPath: loaded.path,
    configDir,
    envFile,
    sandboxDir,
    hostname: publicUrl.hostname,
    portalPort: loaded.config.basePort + serviceDef("portal").docker.hostPortOffset!,
    exposedPorts,
  };
}

export function loadTenantHostConfig(path = HOST_CONFIG_FILENAME): TenantHostConfig {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new CliError(`host config file not found: ${abs}`);
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(abs, "utf8"));
  } catch (error) {
    throw new CliError(`${abs} is not valid JSON: ${errMessage(error)}`);
  }
  if (!object(raw)) throw new CliError(`${abs}: expected a JSON object`);
  allowedKeys(raw, ["contract", "id", "gateway", "tenants"], abs);
  if (raw.contract !== 1) throw new CliError(`${abs}: "contract" must be 1`);
  if (typeof raw.id !== "string" || !validOrgId(raw.id)) {
    throw new CliError(`${abs}: "id" must be a lowercase DNS label`);
  }
  if (!object(raw.gateway)) throw new CliError(`${abs}: "gateway" must be an object`);
  allowedKeys(raw.gateway, ["image", "email"], `${abs}: gateway`);
  if (typeof raw.gateway.image !== "string" || !isDigestPinned(raw.gateway.image)) {
    throw new CliError(`${abs}: "gateway.image" must be an immutable image reference ending in @sha256:<digest>`);
  }
  if (
    raw.gateway.email !== undefined &&
    (typeof raw.gateway.email !== "string" || !/^[^\s@{}]+@[^\s@{}]+$/.test(raw.gateway.email))
  ) {
    throw new CliError(`${abs}: "gateway.email" must be an email address`);
  }
  if (!Array.isArray(raw.tenants) || raw.tenants.length === 0) {
    throw new CliError(`${abs}: "tenants" must be a non-empty array`);
  }
  const dir = dirname(abs);
  const tenants = raw.tenants.map((tenant, index) => tenantOf(tenant, index, dir));
  const duplicate = <T>(values: T[]): T | undefined => values.find((value, index) => values.indexOf(value) !== index);
  const duplicateOrg = duplicate(tenants.map((tenant) => tenant.config.orgId));
  if (duplicateOrg) throw new CliError(`${abs}: duplicate tenant orgId ${JSON.stringify(duplicateOrg)}`);
  const duplicateHost = duplicate(tenants.map((tenant) => tenant.hostname));
  if (duplicateHost) throw new CliError(`${abs}: duplicate tenant hostname ${JSON.stringify(duplicateHost)}`);
  const duplicatePort = duplicate(tenants.flatMap((tenant) => tenant.exposedPorts));
  if (duplicatePort !== undefined)
    throw new CliError(`${abs}: tenant service port ${duplicatePort} is allocated twice`);
  const invalidPort = tenants.flatMap((tenant) => tenant.exposedPorts).find((port) => port < 1 || port > 65535);
  if (invalidPort !== undefined)
    throw new CliError(`${abs}: tenant service port ${invalidPort} is outside 1 through 65535`);
  const reservedPort = tenants
    .flatMap((tenant) => tenant.exposedPorts)
    .find((port) => port === 80 || port === 443 || port === 9080);
  if (reservedPort !== undefined)
    throw new CliError(`${abs}: tenant service port ${reservedPort} is reserved for the host controller`);
  return {
    contract: 1,
    id: raw.id,
    path: abs,
    dir,
    gateway: {
      image: raw.gateway.image,
      ...(typeof raw.gateway.email === "string" ? { email: raw.gateway.email } : {}),
    },
    tenants,
  };
}

export const tenantHostStateDir = (host: TenantHostConfig): string => join(host.dir, ".qm-host");

export function renderTenantHostCaddyfile(host: TenantHostConfig): string {
  const global = [`admin off`, ...(host.gateway.email ? [`email ${host.gateway.email}`] : [])].join("\n");
  const routes = host.tenants
    .map((tenant) => `${tenant.hostname} {\n\treverse_proxy 127.0.0.1:${tenant.portalPort}\n}`)
    .join("\n\n");
  return `{\n${global
    .split("\n")
    .map((line) => `\t${line}`)
    .join("\n")}\n}\n\n${routes}\n`;
}
