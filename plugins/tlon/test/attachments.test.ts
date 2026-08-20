import assert from "node:assert/strict";
import test from "node:test";
import {
  citeReferences,
  downloadMedia,
  mediaReferences,
  safeMediaName,
  type MediaReference,
} from "../src/attachments.ts";

test("Tlon Story cites and native media blobs are parsed with bounded canonical references", () => {
  const content = [
    { block: { cite: { chan: { nest: "chat/~zod/general", where: "/msg/123/456" } } } },
    { block: { cite: { chan: { nest: "chat/~zod/general", where: "/msg/01" } } } },
    { block: { image: { src: "https://cdn.example.com/photo.png", alt: "../photo.png" } } },
  ];
  assert.deepEqual(citeReferences(content), [{ channelId: "chat/~zod/general", postId: "123", replyId: "456" }]);
  assert.deepEqual(
    mediaReferences(
      content,
      JSON.stringify([
        {
          type: "file",
          version: 1,
          fileUri: "https://cdn.example.com/report.pdf",
          mimeType: "application/pdf",
          name: "reports/report.pdf",
          size: 42,
        },
        {
          type: "file",
          version: 1,
          fileUri: "https://cdn.example.com/photo.png",
          mimeType: "image/png",
          name: "duplicate.png",
          size: 5,
        },
      ]),
    ),
    [
      { url: "https://cdn.example.com/photo.png", name: "photo.png", mimetype: "image/*" },
      {
        url: "https://cdn.example.com/report.pdf",
        name: "report.pdf",
        mimetype: "application/pdf",
        sizeBytes: 42,
      },
    ],
  );
  assert.equal(safeMediaName("../../secret.txt"), "secret.txt");
});

test("Tlon media downloads reject redirects and streamed overflows and always close their pinned transport", async () => {
  const source: MediaReference = { url: "https://cdn.example.com/file.bin", name: "file.bin" };
  let closed = 0;
  const transport = (response: Response) => async () => ({
    fetch: (async () => response) as typeof fetch,
    close: async () => {
      closed++;
    },
  });

  const downloaded = await downloadMedia(
    source,
    10,
    transport(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } })),
  );
  assert.deepEqual(downloaded, {
    bytes: new Uint8Array([1, 2, 3]),
    name: "file.bin",
    mimetype: "application/octet-stream",
  });

  await assert.rejects(
    () =>
      downloadMedia(
        source,
        10,
        transport(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })),
      ),
    /redirects are not allowed/,
  );
  await assert.rejects(
    () => downloadMedia(source, 2, transport(new Response(new Uint8Array([1, 2, 3])))),
    /byte limit/,
  );
  assert.equal(closed, 3);
  await assert.rejects(
    () => downloadMedia({ ...source, url: "http://cdn.example.com/file.bin" }, 10, transport(new Response())),
    /public HTTPS/,
  );
});
