import { basename } from "node:path";
import { formatUd, parsePostBlob } from "@tloncorp/api";
import { createPinnedOriginFetch, type PinnedOriginFetch } from "./network.ts";

type RecordValue = Record<string, unknown>;

export interface CiteReference {
  channelId: string;
  postId: string;
  replyId?: string;
}

export interface MediaReference {
  url: string;
  name: string;
  mimetype?: string;
  sizeBytes?: number;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  name: string;
  mimetype: string;
}

export interface CitedPost {
  author: string;
  content: unknown;
}

export const MAX_TLON_ATTACHMENTS = 10;
export const MAX_TLON_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TLON_BLOB_METADATA_CHARS = 100_000;
const MAX_TLON_STORY_VERSES = 100;
const MAX_TLON_URL_CHARS = 8_192;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function normalizedShip(value: unknown): string {
  const source = record(value);
  let raw = "";
  if (typeof value === "string") raw = value;
  else if (typeof source?.ship === "string") raw = source.ship;
  if (!raw) return "";
  return (raw.startsWith("~") ? raw : `~${raw}`).toLowerCase();
}

export function citedPost(value: unknown): CitedPost | null {
  const payload = record(value);
  const reference = record(payload?.reference);
  const post = record(reference?.post);
  const reply = record(reference?.reply);
  const replyValue = record(reply?.reply);
  const source = record(post?.essay) ?? record(replyValue?.["reply-essay"]) ?? record(replyValue?.memo);
  const author = normalizedShip(source?.author);
  return source && author ? { author, content: source.content } : null;
}

function cleanMime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : undefined;
}

function pathName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  } catch {
    return "";
  }
}

export function safeMediaName(value: string, fallback = "attachment"): string {
  const name = basename(value.slice(0, 4_096).replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!name || /^\.+$/.test(name)) return fallback;
  return name.slice(0, 255);
}

function mimeFromName(name: string): string | undefined {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension];
}

function canonicalId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const undotted = value.replace(/\./g, "");
  if (!/^(0|[1-9][0-9]*)$/.test(undotted)) return null;
  const canonical = formatUd(undotted);
  return value.includes(".") && value !== canonical ? null : canonical;
}

function citeWhere(value: unknown): { postId: string; replyId?: string } | null {
  if (typeof value !== "string") return null;
  const legacy = /^\/msg\/~[a-z-]+\/([^/]+)$/.exec(value);
  const current = /^\/(?:msg|note|curio)\/([^/]+)(?:\/([^/]+))?$/.exec(value);
  const postId = canonicalId(legacy?.[1] ?? current?.[1]);
  const replyId = canonicalId(current?.[2]);
  if (!postId || (current?.[2] && !replyId)) return null;
  return { postId, ...(replyId ? { replyId } : {}) };
}

export function citeReferences(content: unknown): CiteReference[] {
  if (!Array.isArray(content)) return [];
  const cites: CiteReference[] = [];
  for (const verse of content.slice(0, MAX_TLON_STORY_VERSES)) {
    const chan = record(record(record(verse)?.block)?.cite)?.chan;
    const channel = record(chan);
    const channelId = typeof channel?.nest === "string" ? channel.nest : "";
    const where = citeWhere(channel?.where);
    if (channelId.length > 512 || !/^(?:chat|heap|diary)\/~[a-z-]+\/[A-Za-z0-9-]+$/.test(channelId) || !where) continue;
    cites.push({ channelId, ...where });
    if (cites.length === 3) break;
  }
  return cites;
}

export function mediaReferences(content: unknown, blob?: string): MediaReference[] {
  const media: MediaReference[] = [];
  const seen = new Set<string>();
  const add = (item: MediaReference): void => {
    if (media.length > MAX_TLON_ATTACHMENTS || seen.has(item.url)) return;
    seen.add(item.url);
    media.push(item);
  };
  if (Array.isArray(content)) {
    for (const verse of content.slice(0, MAX_TLON_STORY_VERSES)) {
      const image = record(record(verse)?.block)?.image;
      const source = record(image);
      if (typeof source?.src !== "string") continue;
      const name = typeof source.alt === "string" && source.alt.trim() ? source.alt : pathName(source.src);
      add({ url: source.src, name: safeMediaName(name, "image"), mimetype: "image/*" });
    }
  }
  if (blob && blob.length <= MAX_TLON_BLOB_METADATA_CHARS) {
    const entries = (() => {
      try {
        return parsePostBlob(blob).slice(0, MAX_TLON_STORY_VERSES);
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      if (entry.type !== "file" && entry.type !== "video" && entry.type !== "voicememo") continue;
      const name = "name" in entry && entry.name ? entry.name : pathName(entry.fileUri);
      let mimetype: string | undefined;
      if (entry.type === "voicememo") mimetype = "audio/*";
      else if (entry.mimeType) mimetype = entry.mimeType;
      add({
        url: entry.fileUri,
        name: safeMediaName(name, entry.type === "voicememo" ? "voice-message" : "attachment"),
        ...(mimetype ? { mimetype } : {}),
        ...(entry.size >= 0 ? { sizeBytes: entry.size } : {}),
      });
    }
  }
  return media;
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("media response had no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`media exceeds ${maxBytes} byte limit`);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadMedia(
  media: MediaReference,
  maxBytes = MAX_TLON_ATTACHMENT_BYTES,
  createTransport: (url: string) => Promise<PinnedOriginFetch> = createPinnedOriginFetch,
  signal?: AbortSignal,
): Promise<DownloadedMedia> {
  if (media.url.length > MAX_TLON_URL_CHARS) throw new Error("media URL is too long");
  const url = new URL(media.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("media URL must be public HTTPS");
  if (media.sizeBytes !== undefined && media.sizeBytes > maxBytes)
    throw new Error(`media exceeds ${maxBytes} byte limit`);
  const transport = await createTransport(url.origin);
  try {
    const response = await transport.fetch(url, {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("media redirects are not allowed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`media download failed with HTTP ${response.status}`);
    }
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`media exceeds ${maxBytes} byte limit`);
    }
    const bytes = await readResponseBytes(response, maxBytes);
    const responseMime = cleanMime(response.headers.get("content-type"));
    const sourceMime = cleanMime(media.mimetype);
    const mimetype =
      responseMime && responseMime !== "application/octet-stream"
        ? responseMime
        : (sourceMime ?? mimeFromName(media.name) ?? "application/octet-stream");
    return {
      bytes,
      name: safeMediaName(media.name),
      mimetype,
    };
  } finally {
    await transport.close();
  }
}

export async function publicMediaUrl(
  value: string,
  createTransport: (url: string) => Promise<PinnedOriginFetch> = createPinnedOriginFetch,
): Promise<string> {
  if (value.length > MAX_TLON_URL_CHARS) throw new Error("media URL is too long");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("media URL must be public HTTPS");
  const transport = await createTransport(url.origin);
  await transport.close();
  return url.href;
}
