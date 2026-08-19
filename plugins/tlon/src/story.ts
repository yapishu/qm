import { isIP } from "node:net";
import type { Code, Link, List, ListItem, Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Story } from "@tloncorp/api";
import { publicAddress } from "./network.ts";

type Inline =
  | string
  | { bold: Inline[] }
  | { italics: Inline[] }
  | { strike: Inline[] }
  | { blockquote: Inline[] }
  | { "inline-code": string }
  | { code: string }
  | { link: { href: string; content: string } }
  | { break: null }
  | { task: { checked: boolean; content: Inline[] } };

type Listing = { item: Inline[] } | { list: { type: ListType; items: Listing[]; contents: Inline[] } };
type ListType = "ordered" | "unordered" | "tasklist";
type Verse = Story[number];

const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_AST_DEPTH = 64;
const MAX_AST_NODES = 20_000;
const MAX_LINE_PREFIX_DEPTH = 64;
const MAX_PARSE_PUNCTUATION = 1_024;
const IMAGE_URL = /\.(?:jpg|img|png|gif|tiff|jpeg|webp|svg)(?:\?.*)?$/i;
const SUPPORTED_AST_NODES = new Set([
  "root",
  "paragraph",
  "heading",
  "thematicBreak",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "html",
  "code",
  "definition",
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "image",
  "linkReference",
  "imageReference",
]);

function mergeText(inlines: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const inline of inlines) {
    const previous = merged.at(-1);
    if (typeof inline === "string" && typeof previous === "string") merged[merged.length - 1] = previous + inline;
    else merged.push(inline);
  }
  return merged;
}

function textToInlines(text: string): Inline[] {
  const inlines: Inline[] = [];
  for (const part of text.split(/(\n)/g)) {
    if (!part) continue;
    if (part === "\n") inlines.push({ break: null });
    else inlines.push(part);
  }
  return mergeText(inlines);
}

function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const rawHostname = url.hostname.toLowerCase();
    const hostname = (rawHostname.startsWith("[") ? rawHostname.slice(1, -1) : rawHostname).replace(/\.+$/, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
    if (isIP(hostname) && !publicAddress(hostname)) return null;
    if (IMAGE_URL.test(url.href)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function markdownFragment(node: RootContent | PhrasingContent): string {
  try {
    return toMarkdown(node as Parameters<typeof toMarkdown>[0]).trim();
  } catch {
    return "value" in node && typeof node.value === "string" ? node.value : "";
  }
}

function visibleText(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text" || node.type === "inlineCode") return node.value;
      if (node.type === "image") return node.alt ?? "";
      if (node.type === "break") return "\n";
      if (node.type === "html") return htmlToText(node.value);
      if ("children" in node) return visibleText(node.children as PhrasingContent[]);
      return "";
    })
    .join("");
}

function phrasingToInlines(nodes: PhrasingContent[]): Inline[] {
  const inlines: Inline[] = [];
  for (const node of nodes) {
    if (node.type === "text") inlines.push(...textToInlines(node.value));
    else if (node.type === "strong") inlines.push({ bold: phrasingToInlines(node.children) });
    else if (node.type === "emphasis") inlines.push({ italics: phrasingToInlines(node.children) });
    else if (node.type === "delete") inlines.push({ strike: phrasingToInlines(node.children) });
    else if (node.type === "inlineCode") inlines.push({ "inline-code": node.value });
    else if (node.type === "link") {
      const link = node as Link;
      const href = safeWebUrl(link.url);
      if (href) inlines.push({ link: { href, content: visibleText(link.children) || href } });
      else inlines.push(...textToInlines(markdownFragment(node)));
    } else if (node.type === "image") {
      inlines.push(...textToInlines(markdownFragment(node)));
    } else if (node.type === "break") inlines.push({ break: null });
    else if (node.type === "html") inlines.push(...textToInlines(htmlToText(node.value)));
    else inlines.push(...textToInlines(markdownFragment(node)));
  }
  return mergeText(inlines);
}

function blockChildrenToInlines(children: RootContent[]): Inline[] {
  const inlines: Inline[] = [];
  for (const child of children) {
    let next: Inline[];
    if (child.type === "paragraph") next = phrasingToInlines(child.children);
    else if (child.type === "blockquote") next = [{ blockquote: blockChildrenToInlines(child.children) }];
    else if (child.type === "code") next = [{ code: child.value }];
    else if (child.type === "heading") next = phrasingToInlines(child.children);
    else if (child.type === "table") next = tableToInlines(child);
    else if (child.type === "html") next = textToInlines(htmlToText(child.value));
    else next = textToInlines(markdownFragment(child));
    if (!next.length) continue;
    if (inlines.length) inlines.push({ break: null });
    inlines.push(...next);
  }
  return inlines;
}

function listType(list: List): ListType {
  if (list.children.some((item) => typeof item.checked === "boolean")) return "tasklist";
  return list.ordered ? "ordered" : "unordered";
}

function listItem(item: ListItem, parentType: ListType): Listing {
  const nested = item.children.find((child): child is List => child.type === "list");
  let contents = blockChildrenToInlines(item.children.filter((child) => child !== nested));
  if (parentType === "tasklist" && typeof item.checked === "boolean") {
    contents = [{ task: { checked: item.checked, content: contents } }];
  }
  if (!nested) return { item: contents };
  const type = listType(nested);
  return { list: { type, contents, items: nested.children.map((child) => listItem(child, type)) } };
}

function paragraphToVerses(paragraph: Paragraph): Verse[] {
  const inlines = phrasingToInlines(paragraph.children);
  return inlines.length ? [{ inline: inlines } as Verse] : [];
}

function tableToInlines(node: Extract<RootContent, { type: "table" }>): Inline[] {
  const inlines: Inline[] = [];
  for (const row of node.children) {
    if (inlines.length) inlines.push({ break: null });
    inlines.push(row.children.map((cell) => visibleText(cell.children)).join(" | "));
  }
  return inlines;
}

function tableToVerse(node: RootContent): Verse | null {
  if (node.type !== "table") return null;
  const inlines = tableToInlines(node);
  return { inline: inlines } as Verse;
}

function nodeToVerses(node: RootContent): Verse[] {
  if (node.type === "paragraph") return paragraphToVerses(node);
  if (node.type === "heading") {
    return [
      {
        block: { header: { tag: `h${node.depth}`, content: phrasingToInlines(node.children) } },
      } as Verse,
    ];
  }
  if (node.type === "code") {
    const code = node as Code;
    const lang =
      code.lang
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "") || "text";
    return [{ block: { code: { code: code.value, lang } } } as Verse];
  }
  if (node.type === "thematicBreak") return [{ block: { rule: null } } as Verse];
  if (node.type === "blockquote") {
    return [{ inline: [{ blockquote: blockChildrenToInlines(node.children) }] } as Verse];
  }
  if (node.type === "list") {
    const type = listType(node);
    return [
      {
        block: { listing: { list: { type, contents: [], items: node.children.map((item) => listItem(item, type)) } } },
      } as Verse,
    ];
  }
  const table = tableToVerse(node);
  if (table) return [table];
  const text = node.type === "html" ? htmlToText(node.value) : markdownFragment(node);
  return text ? [{ inline: textToInlines(text) } as Verse] : [];
}

function needsPlaintextFallback(root: Root): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > MAX_AST_NODES || current.depth > MAX_AST_DEPTH) return true;
    if (!current.node || typeof current.node !== "object") continue;
    const parsed = current.node as { type?: unknown; children?: unknown };
    if (typeof parsed.type !== "string" || !SUPPORTED_AST_NODES.has(parsed.type)) return true;
    const children = parsed.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) stack.push({ node: child, depth: current.depth + 1 });
  }
  return false;
}

function plainStory(markdown: string): Story {
  return markdown.trim() ? ([{ inline: [markdown] }] as Story) : [];
}

function safeToParse(markdown: string): boolean {
  if (markdown.length > MAX_MARKDOWN_LENGTH) return false;
  let punctuation = 0;
  for (let index = 0; index < markdown.length; index++) {
    const code = markdown.charCodeAt(index);
    if (
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    ) {
      if (++punctuation > MAX_PARSE_PUNCTUATION) return false;
    }
  }
  for (const line of markdown.split("\n")) {
    let index = 0;
    let depth = 0;
    while (index < line.length) {
      let whitespace = 0;
      while (line[index] === " " || line[index] === "\t") {
        whitespace += line[index] === "\t" ? 4 : 1;
        index++;
      }
      if (depth === 0 && whitespace > MAX_LINE_PREFIX_DEPTH * 4) return false;
      if (line[index] !== ">") break;
      if (++depth > MAX_LINE_PREFIX_DEPTH) return false;
      index++;
    }
  }
  return true;
}

export function markdownToStory(markdown: string): Story {
  if (!markdown.trim()) return [];
  if (!safeToParse(markdown)) return plainStory(markdown);
  try {
    const tree = processor.runSync(processor.parse(markdown)) as Root;
    if (needsPlaintextFallback(tree)) return plainStory(markdown);
    const story = tree.children.flatMap(nodeToVerses) as Story;
    return story.length ? story : plainStory(markdown);
  } catch {
    return plainStory(markdown);
  }
}
