/**
 * OPDS — any server with an OPDS 1.x catalog that streams pages through OPDS-PSE (Komga, Kavita,
 * Codex, Stump, Ubooquity, …).
 *
 * The catalog's navigation becomes Comical's model this way:
 *
 * - Lists come from the root feed's navigation entries. A feed of series is one list; a feed of
 *   categories (Komga's Libraries, a server's Publishers) becomes one list per category; a feed of
 *   books (Keep Reading) is a list of books.
 * - A series is a feed whose entries are books, and its chapters are those books.
 * - A book met outside a series feed (in Keep Reading, or a search) is a series of one chapter.
 * - Pages are the book's PSE stream. A book without one is listed but can't be opened: the server
 *   offers it only as a whole-file download, which Comical doesn't unpack.
 *
 * Read-only: OPDS has no way to send reading progress back to the server.
 */
import {
  BridgeBase,
  type BridgeInfo,
  CURSOR_MAX_LENGTH,
  type Chapter,
  type HostCapabilities,
  type ImageRequest,
  type InferSettings,
  type ListRequest,
  type Page,
  type PagedResults,
  type SearchRequest,
  type SeriesEntry,
  type SeriesInfo,
  type SeriesList,
  type SettingActionResult,
  type SettingDescriptor,
  type SettingsForm,
  defineBridge,
  defineSettings,
  loginRequiredMessage,
  parseLoginRequired,
} from "@comical/sdk";
import { absoluteFromOrigin, decodeId, encodeId, idKind, relativeToOrigin } from "./core/ids.ts";
import { insecureCredentialsWarning } from "./core/network-safety.ts";
import { authorizedImage, basicAuth, normalizeServerUrl, serverImages } from "./core/server.ts";
import {
  type OpdsEntry,
  type OpdsFeed,
  type XmlLoader,
  coverOf,
  declaredKind,
  isPublication,
  navigationHref,
  nextLink,
  parseFeed,
  pseStreamOf,
} from "./core/opds/feed.ts";
import { fillSearchTemplate, findSearchTemplate } from "./core/opds/search.ts";

const SETTINGS = defineSettings([
  {
    type: "string",
    key: "catalogUrl",
    label: "Catalog URL",
    description: "The address of the server's OPDS catalog.",
    placeholder: "http://192.168.1.5:25600/opds/v1.2/catalog",
    required: true,
  },
  {
    type: "string",
    key: "username",
    label: "Username",
    description: "Leave empty if the catalog needs no sign-in.",
  },
  { type: "string", key: "password", label: "Password", secret: true },
]);
type Settings = InferSettings<typeof SETTINGS>;

/** How long the catalog's list structure is reused before it is walked again. */
const LISTS_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * How long lists are kept when a root feed was empty and so couldn't be told apart (a new reader's
 * On Deck): soon enough that it appears once it has something in it.
 */
const PARTIAL_LISTS_TTL_MS = 10 * 60 * 1000;
/** Root entries and categories walked when building lists, so a huge catalog stays one screen. */
const MAX_ROOT_ENTRIES = 30;
const MAX_CATEGORY_LISTS = 15;
/** Pages of a series feed followed for its chapters, against a server that pages forever. */
const MAX_CHAPTER_PAGES = 100;
/** Lists featured on Home, in catalog order. */
const FEATURED_LISTS = 4;
/** What a PSE `{maxWidth}` is filled with: wide enough that the server never shrinks a page. */
const PSE_MAX_WIDTH = "4096";

const ACCEPT = "application/atom+xml, application/xml;q=0.9, */*;q=0.5";

/** A list: the feed it reads and whether that feed holds series or books. */
interface ListPayload {
  u: string;
  k: "series" | "books";
}
/** A series that is a feed of books. */
interface FeedSeriesPayload {
  u: string;
}
/** A book standing alone as a series: its PSE stream, or its title when it has none. */
interface BookPayload {
  s?: string;
  n?: number;
  t?: string;
}
/** What a card showed for a series, kept so its details don't have to guess. */
interface SeriesMeta {
  t: string;
  c?: string;
  a?: string[];
  d?: string;
}

const metaKey = (seriesId: string): string => `meta:${seriesId}`;

class OpdsBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo;
  private readonly catalogUrl: string | undefined;
  private readonly authorization: string | undefined;
  private readonly load: XmlLoader = (xml) => this.parse("").load(xml, { xml: true });
  private listsMemo: { lists: Promise<SeriesList[]>; until: number } | undefined;
  private searchMemo: Promise<string | undefined> | undefined;

  constructor(host: HostCapabilities) {
    super(host);
    const raw = this.setting("catalogUrl");
    let catalogUrl: string | undefined;
    try {
      catalogUrl = raw ? normalizeServerUrl(raw) : undefined;
    } catch {
      catalogUrl = undefined;
    }
    this.catalogUrl = catalogUrl;
    const username = this.setting("username")?.trim();
    this.authorization = username ? basicAuth(username, this.setting("password") ?? "") : undefined;

    const images = serverImages(catalogUrl, this.authorization !== undefined);
    this.info = {
      id: "porksphere.opds",
      name: "OPDS",
      version: "0.1.0",
      contractVersion: "2.1.0",
      languages: ["multi"],
      nsfw: false,
      capabilities: ["lists", "search", "settings"],
      rateLimit: { maxConcurrent: 6 },
      ...(images ? { images } : {}),
    };
  }

  // ---- Settings ----

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  loadSettings(): Promise<SettingsForm> {
    const [catalogUrl, username, password] = SETTINGS;
    const warning = insecureCredentialsWarning(this.catalogUrl, this.authorization !== undefined);
    return Promise.resolve({
      sections: [
        {
          title: "Server",
          items: [catalogUrl],
          footer:
            "The OPDS catalog's address, as the server's own settings show it. Komga's is " +
            "http://<server>:25600/opds/v1.2/catalog. Books open only on servers that stream " +
            "pages (OPDS-PSE).",
        },
        {
          title: "Sign-in",
          items: [username, password],
          ...(warning ? { footer: warning } : {}),
        },
        { items: [{ type: "action", key: "test", label: "Test connection" }] },
      ],
    });
  }

  async runSettingAction(key: string): Promise<SettingActionResult> {
    if (key !== "test") throw new Error(`unknown setting action: ${key}`);
    if (!this.catalogUrl) return { ok: false, message: "Enter the catalog URL first." };
    try {
      const root = await this.fetchFeed(this.catalogUrl);
      return { ok: true, message: `Connected to “${root.title}”.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The settings form shows this to the user as it is: the sign-in marker is for hosts.
      return { ok: false, message: parseLoginRequired(message)?.reason ?? message };
    }
  }

  interceptImageRequest(url: string): Promise<ImageRequest> {
    return Promise.resolve(authorizedImage(url, this.authorization));
  }

  // ---- Lists ----

  getLists(): Promise<SeriesList[]> {
    if (this.listsMemo && Date.now() < this.listsMemo.until) return this.listsMemo.lists;
    const memo = { lists: Promise.resolve<SeriesList[]>([]), until: Number.POSITIVE_INFINITY };
    memo.lists = this.cachedLists().then(
      ({ lists, until }) => {
        memo.until = until;
        return lists;
      },
      (e: unknown) => {
        if (this.listsMemo === memo) this.listsMemo = undefined;
        throw e;
      },
    );
    this.listsMemo = memo;
    return memo.lists;
  }

  async getListItems(listId: string, req?: ListRequest): Promise<PagedResults<SeriesEntry>> {
    const list = decodeId<ListPayload>("l", listId);
    return this.readEntries(req?.cursor ? this.abs(req.cursor) : this.abs(list.u));
  }

  // ---- Search ----

  async getSearchResults(req: SearchRequest): Promise<PagedResults<SeriesEntry>> {
    if (req.cursor) return this.readEntries(this.abs(req.cursor));
    this.searchMemo ??= this.fetchFeed(this.catalog()).then((root) =>
      findSearchTemplate(root, (url) => this.fetchText(url, this.headers()), this.load),
    );
    const template = await this.searchMemo.catch((e: unknown) => {
      this.searchMemo = undefined;
      throw e;
    });
    if (!template) throw new Error("This catalog doesn't offer search.");
    return this.readEntries(fillSearchTemplate(template, req.text));
  }

  // ---- Series ----

  async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const meta = await this.meta(seriesId);
    if (idKind(seriesId) === "b") {
      return this.seriesInfo(seriesId, meta?.t ?? decodeId<BookPayload>("b", seriesId).t ?? "Untitled", meta);
    }
    const feed = await this.fetchFeed(this.abs(decodeId<FeedSeriesPayload>("f", seriesId).u));
    const firstBook = feed.entries.find(isPublication);
    const cover = meta?.c ?? (firstBook ? this.relOpt(coverOf(firstBook)) : undefined);
    const authors = meta?.a ?? firstBook?.authors;
    return this.seriesInfo(seriesId, meta?.t ?? feed.title, {
      t: meta?.t ?? feed.title,
      ...(cover ? { c: cover } : {}),
      ...(authors?.length ? { a: authors } : {}),
      ...((meta?.d ?? feed.subtitle) ? { d: (meta?.d ?? feed.subtitle)! } : {}),
    });
  }

  override async getChapters(seriesId: string): Promise<Chapter[]> {
    if (idKind(seriesId) === "b") {
      const book = decodeId<BookPayload>("b", seriesId);
      const name = (await this.meta(seriesId))?.t ?? book.t ?? "Book";
      return [
        book.s && book.n
          ? { id: encodeId("c", { s: book.s, n: book.n }), name, pageCount: book.n }
          : { id: encodeId("x", { t: name }), name },
      ];
    }
    const chapters: Chapter[] = [];
    const seen = new Set<string>();
    let url: string | undefined = this.abs(decodeId<FeedSeriesPayload>("f", seriesId).u);
    for (let page = 0; url && page < MAX_CHAPTER_PAGES && !seen.has(url); page++) {
      seen.add(url);
      const feed = await this.fetchFeed(url);
      for (const entry of feed.entries) if (isPublication(entry)) chapters.push(this.chapterOf(entry));
      url = nextLink(feed);
    }
    return chapters;
  }

  override getChapterPages(_seriesId: string, chapterId: string): Promise<Page[]> {
    if (idKind(chapterId) === "x") {
      return Promise.reject(
        new Error(
          "This book can't be opened in Comical: the server offers it only as a download, " +
            "without page streaming (OPDS-PSE).",
        ),
      );
    }
    const { s, n } = decodeId<{ s: string; n: number }>("c", chapterId);
    // Resolving the template percent-encodes its braces; put the placeholders back.
    const template = this.abs(s).replace(/%7B([\w:]+\??)%7D/gi, "{$1}");
    return Promise.resolve(
      Array.from({ length: n }, (_, index) => ({
        index,
        imageUrl: template
          .replace(/\{pageNumber\}/g, String(index))
          .replace(/\{maxWidth\}/g, PSE_MAX_WIDTH)
          .replace(/\{[\w:]+\??\}/g, ""),
      })),
    );
  }

  // ---- Internals ----

  private catalog(): string {
    if (!this.catalogUrl) throw new Error('required setting "catalogUrl" is not configured');
    return this.catalogUrl;
  }

  private abs(ref: string): string {
    return absoluteFromOrigin(ref, this.catalog());
  }

  private rel(url: string): string {
    return relativeToOrigin(url, this.catalog());
  }

  private relOpt(url: string | undefined): string | undefined {
    return url ? this.rel(url) : undefined;
  }

  private headers(): Record<string, string> {
    return this.authorization ? { Accept: ACCEPT, Authorization: this.authorization } : { Accept: ACCEPT };
  }

  private async fetchFeed(url: string): Promise<OpdsFeed> {
    const res = await this.request({ url, headers: this.headers() });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        loginRequiredMessage(
          "username",
          this.authorization
            ? "The server turned down this username and password."
            : "This catalog needs a username and password.",
        ),
      );
    }
    if (res.status >= 400) throw new Error(`The server answered HTTP ${res.status} for ${url}`);
    return parseFeed(res.body, res.url || url, this.load);
  }

  /** The lists, from storage while they are fresh, and until when they are. */
  private async cachedLists(): Promise<{ lists: SeriesList[]; until: number }> {
    const key = `lists:${this.catalog()}`;
    const stored = await this.storage.get(key);
    if (stored) {
      try {
        const { until, lists } = JSON.parse(stored) as { until?: number; lists: SeriesList[] };
        if (typeof until === "number" && Date.now() < until && lists.length > 0) return { lists, until };
      } catch {
        // A corrupt cache is rebuilt below.
      }
    }
    const { lists, complete } = await this.buildLists();
    const until = Date.now() + (complete ? LISTS_TTL_MS : PARTIAL_LISTS_TTL_MS);
    if (lists.length > 0) await this.storage.set(key, JSON.stringify({ until, lists }));
    return { lists, until: lists.length > 0 ? until : 0 };
  }

  /** The lists, and whether every root feed could be told apart (none was empty or failed). */
  private async buildLists(): Promise<{ lists: SeriesList[]; complete: boolean }> {
    const root = await this.fetchFeed(this.catalog());
    const found: Array<{ name: string; description?: string; payload: ListPayload }> = [];

    // A flat catalog lists its books on the root itself.
    if (root.entries.some(isPublication)) {
      found.push({ name: root.title, payload: { u: this.rel(this.catalog()), k: "books" } });
    }

    const navs = root.entries.filter((e) => navigationHref(e)).slice(0, MAX_ROOT_ENTRIES);
    const classified = await Promise.all(navs.map((nav) => this.classify(nav).catch(() => undefined)));
    const complete = classified.every((c) => c !== undefined);
    navs.forEach((nav, i) => {
      const c = classified[i];
      const href = navigationHref(nav)!;
      if (!c) return;
      if (c.kind === "categories") {
        for (const cat of c.categories.slice(0, MAX_CATEGORY_LISTS)) {
          found.push({
            name: cat.title,
            description: nav.title,
            payload: { u: this.rel(navigationHref(cat)!), k: "series" },
          });
        }
      } else {
        found.push({ name: nav.title, payload: { u: this.rel(href), k: c.kind } });
      }
    });

    const lists = found.map((f, i): SeriesList => ({
      id: encodeId("l", f.payload),
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      layout: i < FEATURED_LISTS ? "carousel" : "grid",
      featured: i < FEATURED_LISTS,
    }));
    return { lists, complete };
  }

  /**
   * What a root navigation entry leads to, by looking: a feed of books, a feed of series (entries
   * leading to feeds of books), or a feed of categories (entries leading to more navigation).
   */
  private async classify(
    nav: OpdsEntry,
  ): Promise<{ kind: "books" | "series" } | { kind: "categories"; categories: OpdsEntry[] } | undefined> {
    const feed = await this.fetchFeed(navigationHref(nav)!);
    if (feed.entries.some(isPublication)) return { kind: "books" };
    const children = feed.entries.filter((e) => navigationHref(e));
    const first = children[0];
    if (!first) return undefined;
    if (declaredKind(first) === "acquisition") return { kind: "series" };
    const sample = await this.fetchFeed(navigationHref(first)!);
    return sample.entries.some(isPublication) ? { kind: "series" } : { kind: "categories", categories: children };
  }

  private async readEntries(url: string): Promise<PagedResults<SeriesEntry>> {
    const feed = await this.fetchFeed(url);
    const items: SeriesEntry[] = [];
    const metas: Array<[string, SeriesMeta]> = [];
    for (const entry of feed.entries) {
      const id = this.seriesIdOf(entry);
      if (!id) continue;
      const cover = this.relOpt(coverOf(entry));
      items.push({ id, title: entry.title, ...(cover ? { thumbnailUrl: this.abs(cover) } : {}) });
      metas.push([
        id,
        {
          t: entry.title,
          ...(cover ? { c: cover } : {}),
          ...(entry.authors.length ? { a: entry.authors } : {}),
          ...(entry.summary ? { d: entry.summary } : {}),
        },
      ]);
    }
    await Promise.all(metas.map(([id, meta]) => this.storage.set(metaKey(id), JSON.stringify(meta))));
    const next = nextLink(feed);
    const cursor = next ? this.rel(next) : undefined;
    return { items, ...(cursor && cursor.length <= CURSOR_MAX_LENGTH ? { nextCursor: cursor } : {}) };
  }

  private seriesIdOf(entry: OpdsEntry): string | undefined {
    if (isPublication(entry)) {
      const stream = pseStreamOf(entry);
      return encodeId("b", stream ? { s: this.rel(stream.template), n: stream.count } : { t: entry.id ?? entry.title });
    }
    const href = navigationHref(entry);
    return href ? encodeId("f", { u: this.rel(href) }) : undefined;
  }

  private chapterOf(entry: OpdsEntry): Chapter {
    const stream = pseStreamOf(entry);
    const issued = entry.issued ? Date.parse(entry.issued) : NaN;
    return {
      id: stream ? encodeId("c", { s: this.rel(stream.template), n: stream.count }) : encodeId("x", { t: entry.title }),
      name: entry.title,
      ...(stream ? { pageCount: stream.count } : {}),
      ...(Number.isFinite(issued) ? { publishedAt: issued } : {}),
    };
  }

  private async meta(seriesId: string): Promise<SeriesMeta | undefined> {
    const raw = await this.storage.get(metaKey(seriesId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SeriesMeta;
    } catch {
      return undefined;
    }
  }

  private seriesInfo(id: string, title: string, meta: SeriesMeta | undefined): SeriesInfo {
    return {
      id,
      title,
      ...(meta?.c ? { thumbnailUrl: this.abs(meta.c) } : {}),
      ...(meta?.a?.length ? { author: meta.a.join(", ") } : {}),
      ...(meta?.d ? { description: meta.d } : {}),
    };
  }
}

export default defineBridge((host) => new OpdsBridge(host));
