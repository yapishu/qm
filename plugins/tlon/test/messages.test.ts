import assert from "node:assert/strict";
import test from "node:test";
import { dmInvites, parseChannelMessage, parseDmMessage } from "../src/messages.ts";
import { createPinnedOriginFetch, publicAddress } from "../src/network.ts";
import { decodeDeliveryTarget, encodeDeliveryTarget } from "../src/target.ts";
import type { Installation } from "../src/types.ts";
import { authenticateShip, originLockedFetch } from "../src/tlon.ts";

const installation: Installation = {
  id: "support",
  principalId: "alice@example.com",
  ship: "~sampel-palnet",
  url: "https://ship.example.com",
  code: "secret",
  ownerShip: "~zod",
  channels: ["chat/~zod/General"],
  respondWithoutMention: false,
  version: "1",
};

const text = (content: unknown): string => String(content);

test("channel messages are principal-bound, owner-only, mention-gated, and threaded", () => {
  const message = parseChannelMessage(
    installation,
    {
      nest: "CHAT/~ZOD/General",
      response: {
        post: {
          id: "root-1",
          "r-post": {
            reply: {
              id: "reply-1",
              "r-reply": {
                set: {
                  "reply-essay": { author: "~zod", content: "~sampel-palnet please help" },
                  seal: { "parent-id": "root-1" },
                },
              },
            },
          },
        },
      },
    },
    text,
  );
  assert.deepEqual(message, {
    accountId: "support",
    installationVersion: "1",
    principalId: "alice@example.com",
    messageId: "reply-1",
    senderShip: "~zod",
    text: "please help",
    content: "~sampel-palnet please help",
    kind: "channel",
    target: "chat/~zod/General",
    threadRoot: "root-1",
  });
  assert.equal(
    parseChannelMessage(
      installation,
      {
        nest: "chat/~zod/general",
        response: { post: { id: "2", "r-post": { set: { essay: { author: "~bus", content: "helper hi" } } } } },
      },
      text,
    ),
    null,
  );
  assert.deepEqual(
    parseChannelMessage(
      installation,
      {
        nest: "chat/~zod/General",
        response: {
          post: {
            id: "top-level-1",
            "r-post": { set: { essay: { author: "~zod", content: "~sampel-palnet top level" } } },
          },
        },
      },
      text,
    ),
    {
      accountId: "support",
      installationVersion: "1",
      principalId: "alice@example.com",
      messageId: "top-level-1",
      senderShip: "~zod",
      text: "top level",
      content: "~sampel-palnet top level",
      kind: "channel",
      target: "chat/~zod/General",
    },
  );
});

test("DM messages route through the user's account and accept only its owner ship", () => {
  const message = parseDmMessage(
    installation,
    {
      whom: "~zod",
      id: "dm-root",
      response: { add: { essay: { author: "~zod", content: "hello" } } },
    },
    text,
  );
  assert.deepEqual(message, {
    accountId: "support",
    installationVersion: "1",
    principalId: "alice@example.com",
    messageId: "dm-root",
    senderShip: "~zod",
    text: "hello",
    content: "hello",
    kind: "dm",
    target: "~zod",
  });
  assert.deepEqual(
    parseDmMessage(
      installation,
      {
        whom: "~zod",
        id: "~zod/dm-root",
        response: {
          reply: {
            id: "dm-reply",
            delta: { add: { "reply-essay": { author: "~zod", content: "inside thread" } } },
          },
        },
      },
      text,
    ),
    {
      accountId: "support",
      installationVersion: "1",
      principalId: "alice@example.com",
      messageId: "dm-reply",
      senderShip: "~zod",
      text: "inside thread",
      content: "inside thread",
      kind: "dm",
      target: "~zod",
      threadRoot: "dm-root",
      parentAuthor: "~zod",
    },
  );
  assert.deepEqual(dmInvites(installation, [{ ship: "~zod" }, { ship: "~bus" }, { ship: "nec" }]), ["~zod"]);
  assert.equal(
    parseDmMessage(
      installation,
      {
        whom: "~zod",
        id: "forged",
        response: { add: { essay: { author: "~nec", content: "not the owner" } } },
      },
      text,
    ),
    null,
  );
});

test("message parsers preserve Story and blob data for connector-side enrichment", () => {
  const content = [{ block: { image: { src: "https://cdn.example.com/photo.png", alt: "photo.png" } } }];
  assert.deepEqual(
    parseDmMessage(
      installation,
      {
        whom: "~zod",
        id: "media-only",
        response: { add: { essay: { author: "~zod", content, blob: '[{"type":"file"}]' } } },
      },
      () => "",
    ),
    {
      accountId: "support",
      installationVersion: "1",
      principalId: "alice@example.com",
      messageId: "media-only",
      senderShip: "~zod",
      text: "",
      content,
      blob: '[{"type":"file"}]',
      kind: "dm",
      target: "~zod",
    },
  );
});

test("delivery targets preserve account identity and reject malformed data", () => {
  const target = { accountId: "support", kind: "channel" as const, target: "chat/~zod/general", replyTo: "root-1" };
  assert.deepEqual(decodeDeliveryTarget(encodeDeliveryTarget(target)), target);
  assert.throws(() => decodeDeliveryTarget(Buffer.from("{}").toString("base64url")), /invalid Tlon delivery target/);
});

test("ship requests cannot leave their configured HTTPS origin or follow redirects", async () => {
  const calls: Array<{ url: string; redirect: RequestInit["redirect"] }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), redirect: init?.redirect });
    return new Response("ok");
  }) as typeof fetch;
  const locked = originLockedFetch("https://ship.example.com", fetchImpl);
  assert.equal((await locked("https://ship.example.com/~/login")).status, 200);
  assert.deepEqual(calls, [{ url: "https://ship.example.com/~/login", redirect: "manual" }]);
  await assert.rejects(() => locked("https://metadata.google.internal/computeMetadata/v1"), /left the configured/);

  const redirecting = originLockedFetch(
    "https://ship.example.com",
    (async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254" } })) as typeof fetch,
  );
  await assert.rejects(() => redirecting("https://ship.example.com/~/login"), /redirects are not allowed/);
});

test("ship authentication exchanges the login code for an origin-bound urbauth cookie", async () => {
  const calls: Array<{ url: string; method: string; contentType: string | null; body: string; cookie: string | null }> =
    [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      contentType: headers.get("content-type"),
      body: String(init?.body ?? ""),
      cookie: headers.get("cookie"),
    });
    if (url.endsWith("/~/login")) {
      return new Response(null, {
        status: 204,
        headers: { "set-cookie": "urbauth-~sampel-palnet=session-secret; Path=/; HttpOnly" },
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const authenticatedFetch = await authenticateShip(
    installation.url,
    installation.ship,
    "code with + and spaces",
    fetchImpl,
  );
  await authenticatedFetch(`${installation.url}/~/channel/1`, {
    method: "PUT",
    headers: { cookie: "undefined" },
    body: "[]",
  });
  assert.deepEqual(calls, [
    {
      url: "https://ship.example.com/~/login",
      method: "POST",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      body: "password=code+with+%2B+and+spaces",
      cookie: null,
    },
    {
      url: "https://ship.example.com/~/channel/1",
      method: "PUT",
      contentType: null,
      body: "[]",
      cookie: "urbauth-~sampel-palnet=session-secret",
    },
  ]);
});

test("ship transports reject internal addresses and pin public DNS results", async () => {
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"])
    assert.equal(publicAddress(address), false);
  await assert.rejects(
    () =>
      createPinnedOriginFetch("https://ship.example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /public network addresses/,
  );
  const transport = await createPinnedOriginFetch("https://ship.example.com", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  await transport.close();
  const ipv6 = await createPinnedOriginFetch("https://[2606:4700:4700::1111]");
  await ipv6.close();
});
