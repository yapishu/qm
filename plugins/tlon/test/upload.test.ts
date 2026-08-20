import assert from "node:assert/strict";
import test from "node:test";
import type { Urbit } from "@tloncorp/api";
import { uploadTlonAttachment } from "../src/upload.ts";
import type { Installation, OutgoingAttachment } from "../src/types.ts";

const installation: Installation = {
  id: "support",
  principalId: "alice@example.com",
  ship: "~sampel-palnet",
  url: "https://ship.example.com",
  code: "secret",
  ownerShip: "~zod",
  channels: [],
  respondWithoutMention: false,
  ownerVerified: true,
  sharedChannelsEnabled: true,
  version: "1",
};

const attachment: OutgoingAttachment = {
  name: "report.pdf",
  mimetype: "application/pdf",
  sizeBytes: 3,
  blobId: "blob-1",
};

function storageClient(): Urbit {
  return {
    scry: async ({ path }: { path: string }) =>
      path === "/configuration"
        ? {
            "storage-update": {
              configuration: {
                currentBucket: "files",
                region: "us-east-1",
                publicUrlBase: "https://cdn.example.com/base/",
                service: "credentials",
              },
            },
          }
        : {
            "storage-update": {
              credentials: {
                endpoint: "https://storage.example.com",
                accessKeyId: "access",
                secretAccessKey: "secret",
              },
            },
          },
  } as unknown as Urbit;
}

test("custom ship uploads use pinned fetches and stable object keys", async () => {
  const fetched: URL[] = [];
  const origins: string[] = [];
  const createTransport = async (origin: string) => {
    origins.push(origin);
    return {
      fetch: (async (input) => {
        fetched.push(new URL(String(input)));
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      close: async () => {},
    };
  };
  const run = (index: number) =>
    uploadTlonAttachment({
      installation,
      client: storageClient(),
      attachment,
      bytes: new Uint8Array([1, 2, 3]),
      deliveryId: "delivery-1",
      index,
      signal: AbortSignal.timeout(1_000),
      createTransport,
    });
  const first = await run(0);
  const second = await run(0);
  const other = await run(1);
  assert.equal(first.url, second.url);
  assert.notEqual(first.url, other.url);
  assert.equal(fetched.length, 3);
  assert.equal(fetched[0]!.origin, "https://storage.example.com");
  assert.equal(fetched[0]!.pathname, fetched[1]!.pathname);
  assert.notEqual(fetched[0]!.pathname, fetched[2]!.pathname);
  assert.deepEqual(origins, [
    "https://storage.example.com",
    "https://cdn.example.com",
    "https://storage.example.com",
    "https://cdn.example.com",
    "https://storage.example.com",
    "https://cdn.example.com",
  ]);
});

test("custom upload public URLs cannot reinterpret attachment names as query or fragment", async () => {
  const createTransport = async () => ({
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    close: async () => {},
  });
  const uploaded = await uploadTlonAttachment({
    installation,
    client: storageClient(),
    attachment: { ...attachment, name: "quarterly#plan?.pdf" },
    bytes: new Uint8Array([1, 2, 3]),
    deliveryId: "special-name",
    index: 0,
    signal: AbortSignal.timeout(1_000),
    createTransport,
  });
  const url = new URL(uploaded.url);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.match(url.pathname, /quarterly_plan_.pdf$/);
});

test("ship storage redirects and hung uploads fail within the caller deadline", async () => {
  const redirectTransport = async () => ({
    fetch: (async () =>
      new Response(null, { status: 307, headers: { location: "http://127.0.0.1/" } })) as typeof fetch,
    close: async () => {},
  });
  await assert.rejects(
    uploadTlonAttachment({
      installation,
      client: storageClient(),
      attachment,
      bytes: new Uint8Array([1, 2, 3]),
      deliveryId: "redirect",
      index: 0,
      signal: AbortSignal.timeout(1_000),
      createTransport: redirectTransport,
    }),
    /redirects are not allowed/,
  );

  const blockedTransport = async () => ({
    fetch: (async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch,
    close: async () => {},
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("upload aborted")), 10);
  try {
    await assert.rejects(
      uploadTlonAttachment({
        installation,
        client: storageClient(),
        attachment,
        bytes: new Uint8Array([1, 2, 3]),
        deliveryId: "blocked",
        index: 0,
        signal: abort.signal,
        createTransport: blockedTransport,
      }),
      /aborted/i,
    );
  } finally {
    clearTimeout(timer);
  }
});
