import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { personalScope } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "tlon-delivery-attachment-secret".repeat(2);

function signed(path: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(SECRET, timestamp, `GET\n${path}\n`),
  };
}

test("Tlon delivery attachment reads survive temporary blob expiry through the durable artifact", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "tlon-delivery-file-")) }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    capabilitySecret: `${SECRET}-capability`,
    portalIdentitySecret: `${SECRET}-portal`,
    requireSignedPortalIdentity: true,
    deliveries: built.deliveries,
    blobTransfer: built.blobTransfer,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const liveBytes = Buffer.from("temporary bytes");
    const staged = await built.blobTransfer.put(liveBytes);
    const live = await built.deliveries.enqueue({
      destination: { type: "tlon", target: "encoded" },
      text: "file",
      attachments: [
        {
          name: "live.txt",
          mimetype: "text/plain",
          sizeBytes: liveBytes.byteLength,
          blobId: staged.blobId,
        },
      ],
      idempotencyKey: "tlon-live-file",
    });
    const livePath = `/v1/deliveries/${live.id}/attachments/0`;
    assert.equal((await fetch(`${base}${livePath}`)).status, 401);
    const liveResponse = await fetch(`${base}${livePath}`, { headers: signed(livePath) });
    assert.equal(liveResponse.status, 200);
    assert.equal(await liveResponse.text(), "temporary bytes");

    const artifactBytes = Buffer.from("durable bytes");
    const artifactId = "a".repeat(32);
    await built.files.put({
      id: artifactId,
      ownerScopeId: personalScope("U1"),
      createdBy: "U1",
      name: "durable.txt",
      path: `artifacts/${artifactId}/durable.txt`,
      mimetype: "text/plain",
      data: Readable.from([artifactBytes]),
      direction: "out",
    });
    const durable = await built.deliveries.enqueue({
      destination: { type: "tlon", target: "encoded" },
      text: "file",
      attachments: [
        {
          name: "durable.txt",
          mimetype: "text/plain",
          sizeBytes: artifactBytes.byteLength,
          blobId: "missing-blob",
          artifactId,
          artifactViewerId: "U1",
        },
      ],
      idempotencyKey: "tlon-durable-file",
    });
    const durablePath = `/v1/deliveries/${durable.id}/attachments/0`;
    const durableResponse = await fetch(`${base}${durablePath}`, { headers: signed(durablePath) });
    assert.equal(durableResponse.status, 200);
    assert.equal(await durableResponse.text(), "durable bytes");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
