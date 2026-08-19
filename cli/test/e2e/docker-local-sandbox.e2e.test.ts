import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  deploymentContainers,
  dockerAvailable,
  dockerCleanup,
  preexistingServiceImages,
  removeStandInImages,
  rmDir,
  runCli,
  standInCheckout,
  tmp,
  writeConfig,
} from "./harness.ts";

const image = "qm-sandbox-local:latest";

function imageAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function lifecycleSkip(): string | false {
  if (!dockerAvailable()) return "no Docker daemon reachable";
  if (!imageAvailable()) return `no ${image}; run npm run sandbox:local:build`;
  if (preexistingServiceImages(["core"]).length) return "refusing to clobber qm-core:local";
  return false;
}

function waitForHealth(core: string, port: string, token: string): string {
  let last = "";
  for (let i = 0; i < 40; i++) {
    try {
      return execFileSync(
        "docker",
        [
          "exec",
          core,
          "wget",
          "--header",
          `Authorization: Bearer ${token}`,
          "-qO-",
          `http://sandbox-docker:${port}/health`,
        ],
        { encoding: "utf8" },
      );
    } catch (error) {
      last = String(error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  throw new Error(last || "sandbox agent did not become reachable");
}

test(
  "docker local sandbox uses a private nested daemon reachable only through the tenant network",
  { skip: lifecycleSkip() },
  () => {
    const org = `qm-e2e-local-${process.pid}`;
    const dep = tmp("local-sandbox");
    const stateRoot = join(dep, "state");
    const runEnv = { XDG_CONFIG_HOME: stateRoot };
    const checkout = standInCheckout(["core"]);
    const secret = `e2e-${process.pid}-${"x".repeat(32)}`;
    writeFileSync(
      join(dep, ".env"),
      [
        `CORE_SIGNING_SECRET=${secret}`,
        `CAPABILITY_SECRET=${secret}-capability`,
        `CONNECTOR_SECRET_KEY=${secret}-connector`,
        `PORTAL_IDENTITY_SECRET=${secret}-identity`,
        `SKILL_SIGNING_SECRET=${secret}-skill`,
        "",
      ].join("\n"),
    );
    writeConfig(dep, {
      orgId: org,
      target: "docker",
      services: ["core"],
      sandbox: { backend: "local", image },
      env: { core: { HARNESS: "mock" } },
    });
    try {
      const up = runCli(["up", "--build-from", checkout], { cwd: dep, env: runEnv, timeoutMs: 600_000 });
      assert.equal(up.code, 0, up.out);
      const names = deploymentContainers(org);
      const daemon = `qm-${org}-sandbox-docker`;
      const core = `qm-${org}-core`;
      assert.ok(names.includes(daemon), names.join(", "));
      assert.ok(names.includes(core), names.join(", "));
      const coreEnv = execFileSync("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", core], {
        encoding: "utf8",
      });
      assert.match(coreEnv, /^DOCKER_HOST=tcp:\/\/docker:2376$/m);
      assert.match(coreEnv, /^DOCKER_TLS_VERIFY=1$/m);
      assert.match(coreEnv, /^DOCKER_CERT_PATH=\/certs\/client$/m);
      const deploymentState = JSON.parse(
        readFileSync(join(stateRoot, "qm", "deployments", org, "state.json"), "utf8"),
      ) as { sandboxAgentSecret?: string };
      assert.match(deploymentState.sandboxAgentSecret ?? "", /^[0-9a-f]{64}$/);
      assert.match(coreEnv, new RegExp(`^LOCAL_SANDBOX_AUTH_SECRET=${deploymentState.sandboxAgentSecret}$`, "m"));
      const probeAToken = createHmac("sha256", deploymentState.sandboxAgentSecret!).update("qm-probe-a").digest("hex");
      const probeBToken = createHmac("sha256", deploymentState.sandboxAgentSecret!).update("qm-probe-b").digest("hex");
      const coreMounts = execFileSync(
        "docker",
        ["inspect", "-f", "{{range .Mounts}}{{println .Source}}{{end}}", core],
        {
          encoding: "utf8",
        },
      );
      assert.doesNotMatch(coreMounts, /docker\.sock/);
      execFileSync("docker", ["exec", core, "test", "-s", "/certs/client/cert.pem"]);
      execFileSync("docker", ["exec", daemon, "docker", "image", "inspect", image], { stdio: "ignore" });
      execFileSync("docker", [
        "exec",
        daemon,
        "docker",
        "run",
        "-d",
        "--name",
        "qm-probe-a",
        "-e",
        `AGENT_AUTH_TOKEN=${probeAToken}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        "0.0.0.0:0:8080",
        image,
      ]);
      execFileSync("docker", [
        "exec",
        daemon,
        "docker",
        "run",
        "-d",
        "--name",
        "qm-probe-b",
        "-e",
        `AGENT_AUTH_TOKEN=${probeBToken}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        "0.0.0.0:0:8080",
        image,
      ]);
      const published = execFileSync("docker", ["exec", daemon, "docker", "port", "qm-probe-b", "8080/tcp"], {
        encoding: "utf8",
      }).trim();
      const port = /:(\d+)$/.exec(published)?.[1];
      assert.ok(port, published);
      assert.match(waitForHealth(core, port, probeBToken), /"ok":true/);
      const sibling = execFileSync(
        "docker",
        [
          "exec",
          daemon,
          "docker",
          "exec",
          "qm-probe-a",
          "curl",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-H",
          `Authorization: Bearer ${probeAToken}`,
          `http://host.docker.internal:${port}/exec`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(sibling.trim(), "401");
      const unauthorized = spawnSync(
        "docker",
        [
          "exec",
          daemon,
          "docker",
          "exec",
          "qm-probe-a",
          "curl",
          "-sk",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "https://host.docker.internal:2376/_ping",
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(unauthorized.stdout.trim(), "200");
    } finally {
      runCli(["down", "--purge"], { cwd: dep, env: runEnv, timeoutMs: 180_000 });
      dockerCleanup(org);
      removeStandInImages(["core"], org);
      rmDir(dep);
      rmDir(checkout);
    }
  },
);
