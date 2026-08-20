import type { InboundMessage, Installation } from "./types.ts";

type StoryText = (content: unknown) => string;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function ship(value: unknown): string {
  const source = record(value);
  let raw = "";
  if (typeof value === "string") raw = value;
  else if (typeof source?.ship === "string") raw = source.ship;
  if (!raw) return "";
  return (raw.startsWith("~") ? raw : `~${raw}`).toLowerCase();
}

function essay(value: unknown): { author: string; content: unknown; blob?: string } | null {
  const source = record(value);
  if (!source) return null;
  const author = ship(source.author);
  return author
    ? {
        author,
        content: source.content,
        ...(typeof source.blob === "string" && source.blob ? { blob: source.blob } : {}),
      }
    : null;
}

function hasRichPayload(content: { content: unknown; blob?: string }): boolean {
  return Boolean(content.blob) || (Array.isArray(content.content) && content.content.length > 0);
}

function allowed(installation: Installation, sender: string): boolean {
  return sender === installation.ownerShip;
}

function writ(value: unknown, fallbackAuthor: string): { id: string; author: string } {
  const raw = String(value ?? "");
  const slash = raw.indexOf("/");
  if (slash > 0 && raw.startsWith("~")) return { author: ship(raw.slice(0, slash)), id: raw.slice(slash + 1) };
  return { author: fallbackAuthor, id: raw };
}

function channelNest(value: unknown): string {
  if (typeof value !== "string") return "";
  const parts = value.trim().split("/");
  if (parts.length !== 3) return "";
  return `${parts[0]!.toLowerCase()}/${ship(parts[1])}/${parts[2]}`;
}

function mentionText(installation: Installation, text: string): string | null {
  if (installation.respondWithoutMention) return text.trim();
  const mentions = [installation.ship, installation.ship.slice(1)];
  const matched = mentions.find((mention) => text.toLowerCase().includes(mention.toLowerCase()));
  if (!matched) return null;
  return text.replace(new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
}

export function parseChannelMessage(
  installation: Installation,
  value: unknown,
  toText: StoryText,
): InboundMessage | null {
  const event = record(value);
  const nest = channelNest(event?.nest);
  if (!nest || !installation.channels.includes(nest)) return null;
  const response = record(event?.response);
  const post = record(response?.post);
  const postResponse = record(post?.["r-post"]);
  const reply = record(postResponse?.reply);
  const replyResponse = record(reply?.["r-reply"]);
  const replySet = record(replyResponse?.set);
  const postSet = record(postResponse?.set);
  const content = essay(replySet?.["reply-essay"] ?? postSet?.essay);
  if (!content || content.author === installation.ship || !allowed(installation, content.author)) return null;
  const rawText = toText(content.content).trim();
  const text = mentionText(installation, rawText);
  if (text === null || (!text && !hasRichPayload(content))) return null;
  const messageId = String(reply?.id ?? post?.id ?? "");
  if (!messageId) return null;
  const seal = record(replySet?.seal);
  let parent = "";
  if (typeof seal?.["parent-id"] === "string") parent = seal["parent-id"];
  else if (typeof seal?.parent === "string") parent = seal.parent;
  const threadRoot = replySet ? parent || String(post?.id ?? "") : "";
  return {
    accountId: installation.id,
    installationVersion: installation.version,
    principalId: installation.principalId,
    messageId,
    senderShip: content.author,
    text,
    content: content.content,
    ...(content.blob ? { blob: content.blob } : {}),
    kind: "channel",
    target: nest,
    ...(threadRoot ? { threadRoot } : {}),
  };
}

export function parseDmMessage(installation: Installation, value: unknown, toText: StoryText): InboundMessage | null {
  const event = record(value);
  if (!event || Array.isArray(value)) return null;
  const response = record(event.response);
  const added = record(response?.add);
  const reply = record(response?.reply);
  const delta = record(reply?.delta);
  const deltaAdd = record(delta?.add);
  const content = essay(added?.essay ?? deltaAdd?.["reply-essay"]);
  const partner = ship(event.whom);
  if (
    !content ||
    !partner ||
    content.author === installation.ship ||
    !allowed(installation, partner) ||
    !allowed(installation, content.author)
  )
    return null;
  const text = toText(content.content).trim();
  if (!text && !hasRichPayload(content)) return null;
  const messageId = reply ? String(reply.id ?? deltaAdd?.id ?? "") : String(event.id ?? "");
  if (!messageId) return null;
  const parent = reply ? writ(event.id, partner) : null;
  return {
    accountId: installation.id,
    installationVersion: installation.version,
    principalId: installation.principalId,
    messageId,
    senderShip: partner,
    text,
    content: content.content,
    ...(content.blob ? { blob: content.blob } : {}),
    kind: "dm",
    target: partner,
    ...(parent?.id ? { threadRoot: parent.id, parentAuthor: parent.author } : {}),
  };
}

export function dmInvites(installation: Installation, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ship(record(entry)?.ship)).filter((sender) => sender && allowed(installation, sender));
}
