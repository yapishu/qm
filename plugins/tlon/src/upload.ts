import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Urbit } from "@tloncorp/api";
import { publicMediaUrl, readResponseBytes, safeMediaName } from "./attachments.ts";
import { createPinnedOriginFetch, type PinnedOriginFetch } from "./network.ts";
import type { Installation, OutgoingAttachment } from "./types.ts";

interface StorageConfiguration {
  currentBucket: string;
  region: string;
  publicUrlBase: string;
  service: "presigned-url" | "credentials";
}

interface StorageCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface UploadInput {
  installation: Installation;
  client: Urbit;
  attachment: OutgoingAttachment;
  bytes: Uint8Array;
  deliveryId: string;
  index: number;
  signal: AbortSignal;
  createTransport?: (url: string) => Promise<PinnedOriginFetch>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function storageConfiguration(value: unknown): StorageConfiguration {
  const update = object(object(value)?.["storage-update"]);
  const configuration = object(update?.configuration);
  if (
    !configuration ||
    typeof configuration.currentBucket !== "string" ||
    typeof configuration.region !== "string" ||
    typeof configuration.publicUrlBase !== "string" ||
    (configuration.service !== "presigned-url" && configuration.service !== "credentials")
  ) {
    throw new Error("Tlon ship returned invalid storage configuration");
  }
  return configuration as unknown as StorageConfiguration;
}

function storageCredentials(value: unknown): StorageCredentials | null {
  const update = object(object(value)?.["storage-update"]);
  const credentials = object(update?.credentials);
  if (!credentials) return null;
  if (
    typeof credentials.endpoint !== "string" ||
    typeof credentials.accessKeyId !== "string" ||
    typeof credentials.secretAccessKey !== "string"
  ) {
    throw new Error("Tlon ship returned invalid storage credentials");
  }
  if (!credentials.endpoint || !credentials.accessKeyId || !credentials.secretAccessKey) return null;
  return credentials as unknown as StorageCredentials;
}

function hostedShip(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return hostname.endsWith(".tlon.network") || hostname === "tlon.network" || hostname.endsWith(".test.tlon.systems");
}

function uploadKey(input: UploadInput): string {
  const digest = createHash("sha256")
    .update(`${input.deliveryId}\u0000${input.index}\u0000${input.attachment.name}`)
    .digest("hex")
    .slice(0, 24);
  const name = safeMediaName(input.attachment.name).replace(/[?#%]/g, "_");
  return `${input.installation.ship.replace(/^~/, "")}/${digest}-${name}`;
}

function endpointUrl(value: string): URL {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Tlon storage endpoint must be public HTTPS");
  }
  return url;
}

async function memexUpload(input: UploadInput, fileName: string): Promise<string> {
  const createTransport = input.createTransport ?? createPinnedOriginFetch;
  const secret = await input.client.scry<unknown>({ app: "genuine", path: "/secret", timeout: 3_000 });
  if (typeof secret !== "string" || !secret) throw new Error("Tlon ship returned an invalid upload secret");
  const base = (process.env.TLON_MEMEX_URL?.trim() || "https://memex.tlon.network").replace(/\/+$/, "");
  const baseUrl = new URL(base);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Memex endpoint must be public HTTPS");
  }
  const endpoint = new URL(`/v1/${input.installation.ship.replace(/^~/, "")}/upload`, baseUrl);
  if (endpoint.origin !== baseUrl.origin) throw new Error("invalid Tlon upload endpoint");
  const requestTransport = await createTransport(endpoint.origin);
  let response: Response;
  try {
    response = await requestTransport.fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: secret,
        contentLength: input.bytes.byteLength,
        contentType: input.attachment.mimetype,
        fileName,
      }),
      redirect: "manual",
      signal: input.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Tlon storage redirects are not allowed");
    if (!response.ok) throw new Error(`Memex upload request failed with HTTP ${response.status}`);
    const payload = JSON.parse(Buffer.from(await readResponseBytes(response, 16_384)).toString("utf8")) as unknown;
    const record = object(payload);
    if (typeof record?.url !== "string" || typeof record.filePath !== "string") {
      throw new Error("Memex returned an invalid upload target");
    }
    const uploadUrl = new URL(record.url);
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password) {
      throw new Error("Memex upload target must be public HTTPS");
    }
    const uploadTransport = await createTransport(uploadUrl.origin);
    try {
      const uploaded = await uploadTransport.fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": input.attachment.mimetype,
        },
        body: input.bytes,
        redirect: "manual",
        signal: input.signal,
      });
      if (uploaded.status >= 300 && uploaded.status < 400) throw new Error("Tlon storage redirects are not allowed");
      if (!uploaded.ok) throw new Error(`Tlon upload failed with HTTP ${uploaded.status}`);
      await uploaded.body?.cancel().catch(() => undefined);
    } finally {
      await uploadTransport.close();
    }
    return await publicMediaUrl(record.filePath, createTransport);
  } finally {
    await requestTransport.close();
  }
}

async function customUpload(
  input: UploadInput,
  configuration: StorageConfiguration,
  credentials: StorageCredentials,
  fileName: string,
): Promise<string> {
  const createTransport = input.createTransport ?? createPinnedOriginFetch;
  const endpoint = endpointUrl(credentials.endpoint);
  const transport = await createTransport(endpoint.origin);
  const client = new S3Client({
    endpoint: endpoint.href,
    region: configuration.region || "us-east-1",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const digitalOcean = endpoint.hostname.endsWith(".digitaloceanspaces.com");
  const attempt = async (includeAcl: boolean): Promise<{ response: Response; signedUrl: string }> => {
    const headers: Record<string, string> = {
      "content-type": input.attachment.mimetype,
      "cache-control": "public, max-age=3600",
    };
    if (includeAcl && digitalOcean) headers["x-amz-acl"] = "public-read";
    const command = new PutObjectCommand({
      Bucket: configuration.currentBucket,
      Key: fileName,
      ContentType: input.attachment.mimetype,
      CacheControl: "public, max-age=3600",
      ...(includeAcl ? { ACL: "public-read" as const } : {}),
    });
    const signedUrl = await getSignedUrl(client, command, {
      expiresIn: 3_600,
      signableHeaders: new Set(Object.keys(headers)),
    });
    const url = new URL(signedUrl);
    if (url.origin !== endpoint.origin) throw new Error("Tlon storage signer changed origin");
    const response = await transport.fetch(url, {
      method: "PUT",
      body: input.bytes,
      headers,
      redirect: "manual",
      signal: input.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Tlon storage redirects are not allowed");
    return { response, signedUrl };
  };
  try {
    let uploaded = await attempt(true);
    if (uploaded.response.status === 400) {
      await uploaded.response.body?.cancel().catch(() => undefined);
      uploaded = await attempt(false);
    }
    if (!uploaded.response.ok) throw new Error(`Tlon upload failed with HTTP ${uploaded.response.status}`);
    await uploaded.response.body?.cancel().catch(() => undefined);
    const publicUrl = configuration.publicUrlBase
      ? new URL(fileName, configuration.publicUrlBase).href
      : uploaded.signedUrl.split("?", 1)[0]!;
    return await publicMediaUrl(publicUrl, createTransport);
  } finally {
    client.destroy();
    await transport.close();
  }
}

export async function uploadTlonAttachment(input: UploadInput): Promise<{ url: string }> {
  if (input.signal.aborted) throw input.signal.reason;
  const [rawConfiguration, rawCredentials] = await Promise.all([
    input.client.scry<unknown>({ app: "storage", path: "/configuration", timeout: 3_000 }),
    input.client.scry<unknown>({ app: "storage", path: "/credentials", timeout: 3_000 }),
  ]);
  const configuration = storageConfiguration(rawConfiguration);
  const credentials = storageCredentials(rawCredentials);
  const fileName = uploadKey(input);
  const useMemex = hostedShip(input.installation.url) && (configuration.service === "presigned-url" || !credentials);
  if (useMemex) return { url: await memexUpload(input, fileName) };
  if (!credentials || !configuration.currentBucket) throw new Error("Tlon ship has no file storage configured");
  return { url: await customUpload(input, configuration, credentials, fileName) };
}
