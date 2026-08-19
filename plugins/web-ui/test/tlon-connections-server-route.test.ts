import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
  identity: string;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      identity: String(req.headers[PORTAL_IDENTITY_HEADER] ?? ""),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.method === "GET" ? { connections: [] } : { connection: { id: "connection-1" } }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "tlon-web-route-signing-secret";
process.env.WEB_UI_PRINCIPALS = "alice@example.com";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice@example.com", exp: Date.now() + 60_000 },
    "tlon-web-route-signing-secret",
  ),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("Tlon connection routes preserve signed user ownership and discard asserted principals", async () => {
  await fetch(`${base}/api/tlon/connections`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      principalId: "mallory@example.com",
      ship: "~sampel-palnet",
      url: "https://ship.example.com",
      code: "secret-code",
      ownerShip: "~zod",
      channels: ["chat/~sampel-palnet/general", 42],
      respondWithoutMention: true,
    }),
  });
  const created = calls.find((call) => new URL(call.url, "http://core").pathname === "/v1/tlon/connections");
  assert.deepEqual(created?.body, {
    ship: "~sampel-palnet",
    url: "https://ship.example.com",
    code: "secret-code",
    ownerShip: "~zod",
    channels: ["chat/~sampel-palnet/general"],
    respondWithoutMention: true,
  });
  assert.equal(created?.identity, headers[PORTAL_IDENTITY_HEADER]);

  await fetch(`${base}/api/tlon/connections/connection-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ship: "~sampel-palnet", url: "https://new.example.com", ownerShip: "~zod" }),
  });
  await fetch(`${base}/api/tlon/connections/connection-1`, { method: "DELETE", headers });
  assert.ok(calls.some((call) => call.method === "PUT" && call.url.includes("/v1/tlon/connections/connection-1")));
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.includes("/v1/tlon/connections/connection-1")));
});
