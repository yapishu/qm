import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  basePort?: number;
  dockerExec?: DockerExec;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  let nextPort = opts.basePort ?? 9200;
  const ports = new Map<string, number>();
  const freed: number[] = [];
  const allocPort = (n: string): number => {
    const existing = ports.get(n);
    if (existing !== undefined) return existing;
    const port = freed.pop() ?? nextPort++;
    ports.set(n, port);
    return port;
  };
  const freePort = (n: string): void => {
    const p = ports.get(n);
    if (p !== undefined) {
      freed.push(p);
      ports.delete(n);
    }
  };

  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const appVolume = (d: Deployment) => `${name(d)}-app`;
  const seedContainer = (d: Deployment) => `${name(d)}-seed`;
  const remove = async (args: string[], resource: string): Promise<void> => {
    const removed = await dexec(args);
    if (removed.code !== 0 && !/no such (?:object|container|volume)|not found/i.test(removed.stderr)) {
      throw new Error(`deploy ${resource} cleanup failed: ${removed.stderr.trim()}`);
    }
  };
  const removeRuntime = async (d: Deployment): Promise<void> => {
    await remove(["rm", "-f", name(d)], "container");
    await remove(["rm", "-f", seedContainer(d)], "seed");
    await remove(["volume", "rm", "-f", appVolume(d)], "volume");
  };
  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  };

  const migrateContainer = async (container: string): Promise<boolean> => {
    const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid network state`);
    }
    const target = `${container}-net`;
    await ensureNetwork(target);
    if (!(target in attached)) {
      const connected = await dexec(["network", "connect", target, container]);
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`);
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(["network", "disconnect", LEGACY_NETWORK, container]);
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`);
    }
    return true;
  };
  const migrateTarget = async (container: string): Promise<boolean> => {
    try {
      return await migrateContainer(container);
    } catch {
      return migrateContainer(container);
    }
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      await removeRuntime(d);
      const net = await ensureNetwork(network(d));
      const createdVolume = await dexec(["volume", "create", appVolume(d)]);
      if (createdVolume.code !== 0) {
        await dexec(["network", "rm", net]);
        throw new Error(`deploy volume create failed: ${createdVolume.stderr.trim()}`);
      }
      const seed = await dexec([
        "create",
        "--name",
        seedContainer(d),
        "--mount",
        `type=volume,src=${appVolume(d)},dst=/app,volume-nocopy`,
        image,
      ]);
      if (seed.code !== 0) {
        await removeRuntime(d);
        await dexec(["network", "rm", net]);
        throw new Error(`deploy seed create failed: ${seed.stderr.trim()}`);
      }
      const copied = await dexec(["cp", `${version.snapshotDir}/.`, `${seedContainer(d)}:/app`]);
      if (copied.code !== 0) {
        await removeRuntime(d);
        await dexec(["network", "rm", net]);
        throw new Error(`deploy app copy failed: ${copied.stderr.trim()}`);
      }
      const removedSeed = await dexec(["rm", "-f", seedContainer(d)]);
      if (removedSeed.code !== 0) {
        await removeRuntime(d);
        await dexec(["network", "rm", net]);
        throw new Error(`deploy seed cleanup failed: ${removedSeed.stderr.trim()}`);
      }
      const hostPort = allocPort(name(d));
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const r = await dexec([
        "run",
        "-d",
        "--name",
        name(d),
        "--network",
        net,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-p",
        `127.0.0.1:${hostPort}:${APP_PORT}`,
        "--mount",
        `type=volume,src=${appVolume(d)},dst=/app,readonly,volume-nocopy`,
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (r.code !== 0) {
        await removeRuntime(d);
        await dexec(["network", "rm", net]);
        freePort(name(d));
        throw new Error(`deploy run failed: ${r.stderr.trim()}`);
      }
      return { host: "127.0.0.1", port: hostPort };
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await migrateTarget(name(d)))) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      await removeRuntime(d);
      await dexec(["network", "rm", network(d)]);
      freePort(name(d));
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      return (await migrateTarget(name(d))) ? d.endpoint : null;
    },
  };
}
