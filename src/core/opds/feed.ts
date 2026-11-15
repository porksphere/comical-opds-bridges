/**
 * OPDS 1.x (Atom) feeds, parsed into plain data.
 *
 * Elements are matched by LOCAL name, so a feed that prefixes the Atom namespace (`<atom:entry>`)
 * reads the same as one that makes it the default. Every href is resolved against the feed's own
 * URL, so callers only ever see absolute URLs.
 */
import type { CheerioRoot } from "@comical/sdk";

/** Loads an XML document. Bridges pass their SDK cheerio's `load` in XML mode. */
export type XmlLoader = (xml: string) => CheerioRoot;

export interface OpdsLink {
  rel: string | undefined;
  href: string;
  type: string | undefined;
  title: string | undefined;
  /** Every attribute as written, prefixed ones included (`pse:count`). */
  attrs: Readonly<Record<string, string>>;
}

export interface OpdsEntry {
  id: string | undefined;
  title: string;
  updated: string | undefined;
  /** `dcterms:issued` / `dc:issued`, when the server gives one. */
  issued: string | undefined;
  summary: string | undefined;
  authors: string[];
  categories: string[];
  links: OpdsLink[];
}

export interface OpdsFeed {
  id: string | undefined;
  title: string;
  subtitle: string | undefined;
  icon: string | undefined;
  links: OpdsLink[];
  entries: OpdsEntry[];
}

interface El {
  type: string;
  name: string;
  attribs: Record<string, string>;
  children?: El[];
}

const local = (name: string): string => name.slice(name.indexOf(":") + 1).toLowerCase();

const childElements = (el: El): El[] => (el.children ?? []).filter((c) => c.type === "tag");

const children = (el: El, name: string): El[] => childElements(el).filter((c) => local(c.name) === name);

const child = (el: El, name: string): El | undefined => children(el, name)[0];

function resolveHref(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Escaped markup in a text construct, which servers send without `type="html"` (Komga does). */
const ESCAPED_MARKUP = /<\/?(?:br|p|div|b|i|em|strong|span|a|ul|ol|li|h[1-6])\b[^>]*>/i;

/**
 * Komga opens every book's description with its file's format and size ("cbz - 1.2 MiB"), which
 * says nothing about the book.
 */
const FILE_INFO_PREFIX = /^(?:cb[zrt7]|zip|rar|7z|pdf|epub)\s+-\s+[\d.,]+\s*[KMGT]i?B\s*/i;

/**
 * An Atom text construct as plain text: `type="html"` and `type="xhtml"` lose their markup, and so
 * does untyped text carrying escaped markup. `multiline` keeps paragraph and line breaks.
 */
function text($: CheerioRoot, load: XmlLoader, el: El | undefined, multiline = false): string | undefined {
  if (!el) return undefined;
  const type = el.attribs.type?.toLowerCase();
  let value = $(el as never).text();
  if (type === "html" || type === "text/html" || ESCAPED_MARKUP.test(value)) {
    if (multiline) value = value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n");
    value = load(`<x>${value}</x>`)("x").text();
  }
  value = multiline
    ? value
        .replace(/[^\S\n]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : value.replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : undefined;
}

function summaryOf($: CheerioRoot, load: XmlLoader, el: El): string | undefined {
  const value = text($, load, child(el, "summary"), true) ?? text($, load, child(el, "content"), true);
  const trimmed = value?.replace(FILE_INFO_PREFIX, "").trim();
  return trimmed ? trimmed : undefined;
}

function links(el: El, base: string): OpdsLink[] {
  const out: OpdsLink[] = [];
  for (const l of children(el, "link")) {
    const href = l.attribs.href ? resolveHref(l.attribs.href, base) : undefined;
    if (!href) continue;
    out.push({ rel: l.attribs.rel, href, type: l.attribs.type, title: l.attribs.title, attrs: l.attribs });
  }
  return out;
}

function entry($: CheerioRoot, load: XmlLoader, el: El, base: string): OpdsEntry {
  return {
    id: text($, load, child(el, "id")),
    title: text($, load, child(el, "title")) ?? "Untitled",
    updated: text($, load, child(el, "updated")),
    issued: text($, load, child(el, "issued")),
    summary: summaryOf($, load, el),
    // Servers list a person once per role (Komga: writer, then penciller).
    authors: [
      ...new Set(
        children(el, "author")
          .map((a) => text($, load, child(a, "name")))
          .filter((n): n is string => n !== undefined),
      ),
    ],
    categories: children(el, "category")
      .map((c) => c.attribs.label ?? c.attribs.term)
      .filter((c): c is string => typeof c === "string" && c.length > 0),
    links: links(el, base),
  };
}

/** Parse a feed document fetched from `feedUrl`. Throws when it is not an Atom feed at all. */
export function parseFeed(xml: string, feedUrl: string, load: XmlLoader): OpdsFeed {
  const $ = load(xml);
  const root = ($.root().children().toArray() as unknown as El[]).find((c) => c.type === "tag");
  if (!root || local(root.name) !== "feed") {
    throw new Error("the server's answer is not an OPDS catalog (expected an Atom <feed>)");
  }
  const icon = text($, load, child(root, "icon")) ?? text($, load, child(root, "logo"));
  return {
    id: text($, load, child(root, "id")),
    title: text($, load, child(root, "title")) ?? "Catalog",
    subtitle: text($, load, child(root, "subtitle")),
    icon: icon ? resolveHref(icon, feedUrl) : undefined,
    links: links(root, feedUrl),
    entries: children(root, "entry").map((e) => entry($, load, e, feedUrl)),
  };
}

// ---- Reading links ----

export const PSE_STREAM_REL = "http://vaemendis.net/opds-pse/stream";
const ACQUISITION_REL = "http://opds-spec.org/acquisition";
const IMAGE_REL = "http://opds-spec.org/image";
const THUMBNAIL_REL = "http://opds-spec.org/image/thumbnail";

const isAtomType = (type: string | undefined): boolean => (type ?? "").toLowerCase().includes("application/atom+xml");

/** The next page of a paged feed, if any. */
export function nextLink(feed: OpdsFeed): string | undefined {
  return feed.links.find((l) => l.rel === "next")?.href;
}

/** An entry's cover: the thumbnail when there is one (it is what a card needs), else the image. */
export function coverOf(entry: OpdsEntry): string | undefined {
  const byRel = (rel: string) => entry.links.find((l) => l.rel === rel)?.href;
  return (
    byRel(THUMBNAIL_REL) ??
    byRel("x-stanza-cover-image-thumbnail") ??
    byRel(IMAGE_REL) ??
    byRel("x-stanza-cover-image")
  );
}

export interface PseStream {
  /** The href with `{pageNumber}` (and possibly `{maxWidth}`) left in. */
  template: string;
  count: number;
}

/** The entry's OPDS-PSE page stream, when the server offers one with a usable page count. */
export function pseStreamOf(entry: OpdsEntry): PseStream | undefined {
  for (const l of entry.links) {
    if (l.rel !== PSE_STREAM_REL) continue;
    const countAttr = Object.entries(l.attrs).find(([k]) => local(k) === "count")?.[1];
    const count = Number(countAttr);
    if (!Number.isInteger(count) || count <= 0) continue;
    // `new URL` percent-encodes the braces; put the placeholders back.
    const template = l.href.replace(/%7B(\w+)%7D/gi, "{$1}");
    if (!template.includes("{pageNumber}")) continue;
    return { template, count };
  }
  return undefined;
}

/** True for an entry that is a publication (something to read), not a way into another feed. */
export function isPublication(entry: OpdsEntry): boolean {
  return entry.links.some((l) => l.rel === PSE_STREAM_REL || (l.rel ?? "").startsWith(ACQUISITION_REL));
}

/** Where a navigation entry leads, or undefined when it leads nowhere this bridge can follow. */
export function navigationHref(entry: OpdsEntry): string | undefined {
  if (isPublication(entry)) return undefined;
  const sub = entry.links.find((l) => l.rel === "subsection" && isAtomType(l.type));
  if (sub) return sub.href;
  const any = entry.links.find(
    (l) => isAtomType(l.type) && l.rel !== "self" && !(l.rel ?? "").startsWith("http://opds-spec.org/"),
  );
  return any?.href;
}

/** The kind a navigation link declares (`kind=acquisition` / `kind=navigation`), if it says. */
export function declaredKind(entry: OpdsEntry): "acquisition" | "navigation" | undefined {
  const href = navigationHref(entry);
  const link = entry.links.find((l) => l.href === href);
  const m = /kind=(acquisition|navigation)/i.exec(link?.type ?? "");
  return m ? (m[1]!.toLowerCase() as "acquisition" | "navigation") : undefined;
}
