/**
 * Komga, through its REST API (Komga 1.19 or later, for the search-condition list endpoints).
 *
 * - Ids are Komga's own: a series is a Komga series, a chapter is one of its books. They are
 *   server-scoped and never change, so they survive the server moving to a new address.
 * - Lists are Keep reading, On deck, Recently added and Recently updated (each only when it has
 *   something in it), then one per library and one per collection. Keep reading and On deck hold
 *   books: each card opens the book's series.
 * - Reading state syncs both ways (capability "read-sync"): finishing a book in Comical marks it
 *   read on Komga, and books read elsewhere come back as read on the next library refresh.
 */
import {
  BridgeBase,
  type BridgeInfo,
  type Chapter,
  type HostCapabilities,
  type HttpMethod,
  type ImageRequest,
  type InferSettings,
  type LinkTarget,
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
  seriesGoneMessage,
} from "@comical/sdk";
import { insecureCredentialsWarning } from "./core/network-safety.ts";
import { authorizedImage, basicAuth, hostnameOf, normalizeServerUrl, serverImages } from "./core/server.ts";

const SETTINGS = defineSettings([
  {
    type: "string",
    key: "serverUrl",
    label: "Server address",
    description: "Komga's address, as you open it in a browser.",
    placeholder: "http://192.168.1.5:25600",
    required: true,
  },
  {
    type: "string",
    key: "apiKey",
    label: "API key",
    description: "Create one in Komga under Account settings → API keys.",
    secret: true,
  },
  { type: "string", key: "username", label: "Email", description: "Or sign in with your Komga email and password." },
  { type: "string", key: "password", label: "Password", secret: true },
]);
type Settings = InferSettings<typeof SETTINGS>;

const PAGE_SIZE = 24;
/** Collections offered as lists, so a server with hundreds stays one screen. */
const MAX_COLLECTION_LISTS = 20;
/** How long the lists are reused: soon enough that On deck appears once you start reading. */
const LISTS_TTL_MS = 5 * 60 * 1000;
/** Page formats every client decodes; Komga converts anything else (JPEG XL, AVIF, HEIF…) to PNG. */
const DECODABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TOO_OLD = "Comical needs Komga 1.19 or later. Update Komga, or use the OPDS bridge.";

/** Komga's web routes and API prefixes: a pasted link is cut back to the server's own address. */
const SERVER_PATH =
  /\/(?:api|opds|sse|series|book|oneshot|libraries|collections|readlists|readlist|dashboard|login|settings|account|history|media-management|import)(?:\/.*)?$/i;

/** The server's base address from what a user typed or pasted: a Komga page or API link works too. */
export function komgaBase(raw: string): string {
  const url = new URL(normalizeServerUrl(raw));
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(SERVER_PATH, "");
  return url.toString().replace(/\/+$/, "");
}

// ---- Komga's API, as much of it as the bridge reads ----

interface KPage<T> {
  content: T[];
  last: boolean;
  number: number;
}
interface KAuthor {
  name: string;
  role: string;
}
interface KSeries {
  id: string;
  name: string;
  booksCount: number;
  booksReadCount: number;
  booksUnreadCount: number;
  booksInProgressCount: number;
  oneshot?: boolean;
  metadata: {
    status?: string;
    title?: string;
    summary?: string;
    readingDirection?: string;
    publisher?: string;
    ageRating?: number | null;
    language?: string;
    genres?: string[];
    tags?: string[];
    totalBookCount?: number | null;
    alternateTitles?: Array<{ label?: string; title: string }>;
  };
  booksMetadata?: {
    authors?: KAuthor[];
    summary?: string;
    releaseDate?: string | null;
    tags?: string[];
  };
}
interface KBook {
  id: string;
  seriesId: string;
  seriesTitle: string;
  name: string;
  deleted?: boolean;
  media: { status: string; mediaType?: string; pagesCount: number; mediaProfile?: string; epubDivinaCompatible?: boolean };
  metadata: { title?: string; numberSort?: number; releaseDate?: string | null };
  readProgress?: { page: number; completed: boolean } | null;
}
interface KPageDto {
  number: number;
  mediaType?: string;
}
interface KLibrary {
  id: string;
  name: string;
  unavailable?: boolean;
}
interface KCollection {
  id: string;
  name: string;
}
interface KUser {
  email: string;
  roles: string[];
}

/** The lists whose entries are books (each card opens its series); the rest hold series. */
const BOOK_LISTS = new Set(["keep-reading", "on-deck"]);

type Condition = Record<string, unknown>;
const is = (field: string, value: string): Condition => ({ [field]: { operator: "is", value } });

const READING_DIRECTION: Record<string, SeriesInfo["readingDirection"]> = {
  LEFT_TO_RIGHT: "ltr",
  RIGHT_TO_LEFT: "rtl",
  VERTICAL: "vertical",
  WEBTOON: "vertical",
};
const STATUS: Record<string, SeriesInfo["status"]> = {
  ONGOING: "ongoing",
  ENDED: "completed",
  HIATUS: "hiatus",
  ABANDONED: "cancelled",
};
const WRITER_ROLES = new Set(["writer"]);
const ARTIST_ROLES = new Set(["penciller", "inker", "colorist", "artist", "cover"]);

function contentRating(age: number | null | undefined): SeriesInfo["contentRating"] {
  if (typeof age !== "number") return undefined;
  if (age >= 18) return "adult";
  return age >= 16 ? "mature" : "everyone";
}

/** Names with one of `roles`, once each, in Komga's order. */
function names(authors: KAuthor[] | undefined, roles: Set<string>): string[] {
  return [...new Set((authors ?? []).filter((a) => roles.has(a.role.toLowerCase())).map((a) => a.name))];
}

/** Komga answered with an error status the bridge has no better words for. */
class KomgaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

class KomgaBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo;
  private readonly base: string | undefined;
  private readonly auth: Record<string, string> | undefined;
  private readonly authKey: "apiKey" | "username";
  private listsMemo: { lists: Promise<SeriesList[]>; until: number } | undefined;

  constructor(host: HostCapabilities) {
    super(host);
    const raw = this.setting("serverUrl");
    let base: string | undefined;
    try {
      base = raw ? komgaBase(raw) : undefined;
    } catch {
      base = undefined;
    }
    this.base = base;

    const apiKey = this.setting("apiKey")?.trim();
    const username = this.setting("username")?.trim();
    if (apiKey) {
      this.auth = { "X-API-Key": apiKey };
      this.authKey = "apiKey";
    } else if (username) {
      this.auth = { Authorization: basicAuth(username, this.setting("password") ?? "") };
      this.authKey = "username";
    } else {
      this.auth = undefined;
      this.authKey = "apiKey";
    }

    const images = serverImages(base, this.auth !== undefined);
    this.info = {
      id: "porksphere.komga",
      name: "Komga",
      version: "0.1.0",
      contractVersion: "2.1.0",
      languages: ["multi"],
      nsfw: false,
      capabilities: ["lists", "search", "settings", "read-sync"],
      cardSubtitles: true,
      rateLimit: { maxConcurrent: 6 },
      ...(images ? { images } : {}),
      ...(base ? { linkHosts: [hostnameOf(base)] } : {}),
    };
  }

  // ---- Settings ----

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  loadSettings(): Promise<SettingsForm> {
    const [serverUrl, apiKey, username, password] = SETTINGS;
    const warning = insecureCredentialsWarning(this.base, this.auth !== undefined);
    return Promise.resolve({
      sections: [
        { title: "Server", items: [serverUrl] },
        {
          title: "Sign-in",
          items: [apiKey, username, password],
          footer:
            warning ??
            "An API key, or your email and password. The account needs Komga's Page streaming role " +
              "to open books.",
        },
        { items: [{ type: "action", key: "test", label: "Test connection" }] },
      ],
    });
  }

  async runSettingAction(key: string): Promise<SettingActionResult> {
    if (key !== "test") throw new Error(`unknown setting action: ${key}`);
    if (!this.base) return { ok: false, message: "Enter Komga's address first." };
    try {
      const me = await this.api<KUser>("/api/v2/users/me");
      if (!me.roles.includes("PAGE_STREAMING") && !me.roles.includes("ADMIN")) {
        return {
          ok: false,
          message: `Signed in as ${me.email}, but this account can't open books: give it the Page streaming role in Komga.`,
        };
      }
      await this.api<KPage<KBook>>("/api/v1/books/list", { method: "POST", query: { size: 1 }, body: {}, listApi: true });
      return { ok: true, message: `Signed in to Komga as ${me.email}.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message: parseLoginRequired(message)?.reason ?? message };
    }
  }

  interceptImageRequest(url: string): Promise<ImageRequest> {
    return Promise.resolve(authorizedImage(url, this.auth));
  }

  // ---- Lists ----

  getLists(): Promise<SeriesList[]> {
    if (this.listsMemo && Date.now() < this.listsMemo.until) return this.listsMemo.lists;
    const memo = { lists: this.buildLists(), until: Date.now() + LISTS_TTL_MS };
    memo.lists.catch(() => {
      if (this.listsMemo === memo) this.listsMemo = undefined;
    });
    this.listsMemo = memo;
    return memo.lists;
  }

  private async buildLists(): Promise<SeriesList[]> {
    // The personal and recent lists are left out while they are empty (a new reader's On deck):
    // one item each says whether they have anything.
    const fixed: Array<[string, string]> = [
      ["keep-reading", "Keep reading"],
      ["on-deck", "On deck"],
      ["new", "Recently added"],
      ["updated", "Recently updated"],
    ];
    const [libraries, collections, ...filled] = await Promise.all([
      this.api<KLibrary[]>("/api/v1/libraries"),
      // Collections are a nicety: a server that refuses them still has its lists.
      this.api<KPage<KCollection>>("/api/v1/collections", { query: { unpaged: true } }).then(
        (p) => p.content,
        () => [] as KCollection[],
      ),
      ...fixed.map(([id]) => this.listPage(id, 0, 1).then((p) => p.content.length > 0)),
    ]);
    return [
      ...fixed
        .filter((_, i) => filled[i])
        .map(([id, name]): SeriesList => ({ id, name, layout: "carousel", featured: true })),
      ...libraries
        .filter((l) => !l.unavailable)
        .map((l): SeriesList => ({ id: `library:${l.id}`, name: l.name, description: "Library", layout: "grid" })),
      ...collections
        .slice(0, MAX_COLLECTION_LISTS)
        .map((c): SeriesList => ({ id: `collection:${c.id}`, name: c.name, description: "Collection", layout: "grid" })),
    ];
  }

  async getListItems(listId: string, req?: ListRequest): Promise<PagedResults<SeriesEntry>> {
    const page = req?.cursor ? Number(req.cursor) : 0;
    if (!Number.isInteger(page) || page < 0) throw new Error(`bad cursor: ${req?.cursor}`);
    const result = await this.listPage(listId, page, PAGE_SIZE);
    return BOOK_LISTS.has(listId)
      ? this.bookCards(result as KPage<KBook>)
      : this.seriesCards(result as KPage<KSeries>);
  }

  /** One page of a list, as Komga answers it: books for Keep reading and On deck, else series. */
  private listPage(listId: string, page: number, size: number): Promise<KPage<KBook> | KPage<KSeries>> {
    const paging = { page, size };
    switch (listId) {
      case "keep-reading":
        return this.api<KPage<KBook>>("/api/v1/books/list", {
          method: "POST",
          query: { ...paging, sort: "readProgress.readDate,desc" },
          body: { condition: is("readStatus", "IN_PROGRESS") },
          listApi: true,
        });
      case "on-deck":
        return this.api<KPage<KBook>>("/api/v1/books/ondeck", { query: paging });
      case "new":
        return this.api<KPage<KSeries>>("/api/v1/series/new", { query: paging });
      case "updated":
        return this.api<KPage<KSeries>>("/api/v1/series/updated", { query: paging });
    }
    const [kind, id] = listId.split(":", 2);
    if (kind === "library" && id) {
      return this.api<KPage<KSeries>>("/api/v1/series/list", {
        method: "POST",
        query: { ...paging, sort: "metadata.titleSort,asc" },
        body: { condition: is("libraryId", id) },
        listApi: true,
      });
    }
    if (kind === "collection" && id) {
      return this.api<KPage<KSeries>>(`/api/v1/collections/${encodeURIComponent(id)}/series`, { query: paging });
    }
    return Promise.reject(new Error(`unknown list: ${listId}`));
  }

  // ---- Search ----

  async getSearchResults(req: SearchRequest): Promise<PagedResults<SeriesEntry>> {
    const page = req.cursor ? Number(req.cursor) : 0;
    const text = req.text.trim();
    return this.seriesCards(
      await this.api<KPage<KSeries>>("/api/v1/series/list", {
        method: "POST",
        query: { page, size: PAGE_SIZE, ...(text ? {} : { sort: "metadata.titleSort,asc" }) },
        body: text ? { fullTextSearch: text } : {},
        listApi: true,
      }),
    );
  }

  // ---- Series ----

  async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const s = await this.series(seriesId);
    const m = s.metadata;
    const authors = s.booksMetadata?.authors;
    const writers = names(authors, WRITER_ROLES);
    const artists = names(authors, ARTIST_ROLES);
    const credited = writers.length > 0 ? writers : artists;
    const tags = [...new Set([...(m.tags ?? []), ...(s.booksMetadata?.tags ?? [])])];
    const altTitles = [...new Set((m.alternateTitles ?? []).map((a) => a.title).filter((t) => t && t !== m.title))];
    const description = m.summary?.trim() || s.booksMetadata?.summary?.trim();
    const year = s.booksMetadata?.releaseDate?.slice(0, 4);
    const books =
      typeof m.totalBookCount === "number" && m.totalBookCount > s.booksCount
        ? `${s.booksCount} of ${m.totalBookCount}`
        : String(s.booksCount);
    const infoCells = [
      ...(m.publisher ? [{ label: "Publisher", value: m.publisher.slice(0, 80) }] : []),
      { label: "Books", value: books },
      ...(s.booksReadCount > 0 ? [{ label: "Read", value: `${s.booksReadCount} of ${s.booksCount}` }] : []),
      ...(year ? [{ label: "Released", value: year }] : []),
    ];
    const status = m.status ? STATUS[m.status] : undefined;
    const direction = m.readingDirection ? READING_DIRECTION[m.readingDirection] : undefined;
    const rating = contentRating(m.ageRating);
    return {
      id: s.id,
      title: m.title || s.name,
      thumbnailUrl: this.url(`/api/v1/series/${s.id}/thumbnail`),
      ...(altTitles.length ? { altTitles } : {}),
      ...(credited.length ? { author: credited.join(", "), authors: credited.map((name) => ({ name })) } : {}),
      ...(artists.length && writers.length ? { artist: artists.join(", "), artists: artists.map((name) => ({ name })) } : {}),
      ...(description ? { description } : {}),
      ...(status ? { status } : {}),
      ...(direction ? { readingDirection: direction } : {}),
      ...(rating ? { contentRating: rating } : {}),
      ...(m.language ? { languages: [m.language] } : {}),
      tagGroups: [
        ...(m.genres?.length ? [{ label: "Genres", kind: "genre" as const, tags: m.genres }] : []),
        ...(tags.length ? [{ label: "Tags", kind: "other" as const, tags }] : []),
      ],
      infoCells,
      shareUrl: this.url(`/series/${s.id}`),
    };
  }

  override async getChapters(seriesId: string): Promise<Chapter[]> {
    const books = await this.seriesBooks(seriesId);
    return books.map((b): Chapter => {
      const released = b.metadata.releaseDate ? Date.parse(b.metadata.releaseDate) : NaN;
      return {
        id: b.id,
        name: b.metadata.title?.trim() || b.name,
        ...(typeof b.metadata.numberSort === "number" ? { number: b.metadata.numberSort } : {}),
        ...(b.media.pagesCount > 0 ? { pageCount: b.media.pagesCount } : {}),
        ...(Number.isFinite(released) ? { publishedAt: released } : {}),
      };
    });
  }

  override async getChapterPages(_seriesId: string, chapterId: string): Promise<Page[]> {
    const book = encodeURIComponent(chapterId);
    let pages: KPageDto[];
    try {
      pages = await this.api<KPageDto[]>(`/api/v1/books/${book}/pages`, { forbidden: "pages" });
    } catch (e) {
      // Komga answers 400 for a book it has no pages for; explain that, and pass on the rest.
      if (!(e instanceof KomgaHttpError) || (e.status !== 400 && e.status !== 404)) throw e;
      throw new Error(await this.unreadableReason(chapterId).catch(() => e.message));
    }
    if (pages.length === 0) throw new Error(await this.unreadableReason(chapterId));
    return pages.map((p, index): Page => {
      const path = `/api/v1/books/${book}/pages/${p.number}`;
      const convert = p.mediaType && !DECODABLE.has(p.mediaType.toLowerCase()) ? "?convert=png" : "";
      return {
        index,
        imageUrl: this.url(path + convert),
        thumbnail: { kind: "image", url: this.url(`${path}/thumbnail`) },
      };
    });
  }

  // ---- Read-sync ----

  async getReadChapters(seriesId: string): Promise<string[]> {
    const read = await this.api<KPage<KBook>>("/api/v1/books/list", {
      method: "POST",
      query: { unpaged: true },
      body: { condition: { allOf: [is("seriesId", seriesId), is("readStatus", "READ")] } },
      listApi: true,
    });
    return read.content.map((b) => b.id);
  }

  override async markChapterRead(_seriesId: string, chapterId: string): Promise<void> {
    await this.api(`/api/v1/books/${encodeURIComponent(chapterId)}/read-progress`, {
      method: "PATCH",
      body: { completed: true },
    });
  }

  override async markChapterUnread(_seriesId: string, chapterId: string): Promise<void> {
    await this.api(`/api/v1/books/${encodeURIComponent(chapterId)}/read-progress`, { method: "DELETE" });
  }

  // ---- Links ----

  async resolveUrl(url: string): Promise<LinkTarget | null> {
    if (!this.base) return null;
    let path: string;
    try {
      const u = new URL(url);
      const base = new URL(this.base);
      if (u.host !== base.host || !u.pathname.startsWith(base.pathname)) return null;
      path = u.pathname.slice(base.pathname.replace(/\/$/, "").length);
    } catch {
      return null;
    }
    const series = /^\/series\/([^/]+)/.exec(path);
    if (series?.[1]) return { seriesId: decodeURIComponent(series[1]) };
    const book = /^\/(?:book|oneshot)\/([^/]+)/.exec(path);
    if (book?.[1]) {
      const b = await this.api<KBook>(`/api/v1/books/${book[1]}`);
      return { seriesId: b.seriesId, chapterId: b.id };
    }
    return null;
  }

  // ---- Internals ----

  private server(): string {
    if (!this.base) throw new Error('required setting "serverUrl" is not configured');
    return this.base;
  }

  private url(path: string): string {
    return this.server() + path;
  }

  private async series(seriesId: string): Promise<KSeries> {
    return this.api<KSeries>(`/api/v1/series/${encodeURIComponent(seriesId)}`, { gone: true });
  }

  private async seriesBooks(seriesId: string): Promise<KBook[]> {
    const books = await this.api<KPage<KBook>>("/api/v1/books/list", {
      method: "POST",
      query: { unpaged: true, sort: "metadata.numberSort,asc" },
      body: { condition: is("seriesId", seriesId) },
      listApi: true,
    });
    if (books.content.length === 0) await this.series(seriesId); // a series that is gone says so
    return books.content.filter((b) => !b.deleted);
  }

  /** Why Komga has no pages for a book, in words a reader can act on. */
  private async unreadableReason(bookId: string): Promise<string> {
    const b = await this.api<KBook>(`/api/v1/books/${encodeURIComponent(bookId)}`);
    if (b.media.mediaProfile === "EPUB" && !b.media.epubDivinaCompatible) {
      return "This book is a text EPUB: Comical reads comics page by page, and Komga has no pages to give for it.";
    }
    if (b.media.status !== "READY") {
      return `Komga can't open this book yet (its media is ${b.media.status.toLowerCase()}). Analyze it in Komga, then try again.`;
    }
    return "Komga has no pages for this book.";
  }

  private seriesCards(page: KPage<KSeries>): PagedResults<SeriesEntry> {
    const items = page.content.map((s): SeriesEntry => {
      const direction = s.metadata.readingDirection ? READING_DIRECTION[s.metadata.readingDirection] : undefined;
      const rating = contentRating(s.metadata.ageRating);
      return {
        id: s.id,
        title: s.metadata.title || s.name,
        thumbnailUrl: this.url(`/api/v1/series/${s.id}/thumbnail`),
        ...(s.oneshot ? {} : { subtitle: plural(s.booksCount, "book") }),
        ...(s.booksUnreadCount > 0 && !s.oneshot
          ? { badges: [{ text: String(s.booksUnreadCount), position: "top-right" as const, tone: "info" as const }] }
          : {}),
        ...(direction ? { readingDirection: direction } : {}),
        ...(rating ? { contentRating: rating } : {}),
      };
    });
    return { items, ...(page.last ? {} : { nextCursor: String(page.number + 1) }) };
  }

  /** Books as cards for their series, each series once, showing the book and its cover. */
  private bookCards(page: KPage<KBook>): PagedResults<SeriesEntry> {
    const seen = new Set<string>();
    const items: SeriesEntry[] = [];
    for (const b of page.content) {
      if (seen.has(b.seriesId)) continue;
      seen.add(b.seriesId);
      const title = b.metadata.title?.trim() || b.name;
      items.push({
        id: b.seriesId,
        title: b.seriesTitle || title,
        ...(title !== b.seriesTitle ? { subtitle: title } : {}),
        thumbnailUrl: this.url(`/api/v1/books/${b.id}/thumbnail`),
      });
    }
    return { items, ...(page.last ? {} : { nextCursor: String(page.number + 1) }) };
  }

  /**
   * One call to Komga's API, parsed. `listApi` marks the search-condition endpoints, whose absence
   * means an older Komga; `gone` marks a series lookup, whose 404 means the series was removed;
   * `forbidden` names what a 403 refused.
   */
  private async api<T = unknown>(
    path: string,
    opts: {
      method?: HttpMethod;
      query?: Record<string, string | number | boolean>;
      body?: unknown;
      listApi?: boolean;
      gone?: boolean;
      forbidden?: "pages";
    } = {},
  ): Promise<T> {
    const query = opts.query
      ? "?" + Object.entries(opts.query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
      : "";
    const url = this.url(path + query);
    const headers: Record<string, string> = { Accept: "application/json", ...this.auth };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.request({
      url,
      method: opts.method ?? "GET",
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    if (res.status === 401) {
      throw new Error(
        loginRequiredMessage(
          this.authKey,
          this.auth
            ? "Komga turned down this sign-in."
            : "Komga needs an API key, or your email and password.",
        ),
      );
    }
    if (res.status === 403) {
      throw new Error(
        opts.forbidden === "pages"
          ? "This Komga account can't open books: give it the Page streaming role in Komga."
          : "Komga refused this request: the account isn't allowed to do it.",
      );
    }
    if (res.status === 404 && opts.gone) throw new Error(seriesGoneMessage("removed from Komga"));
    if ((res.status === 404 || res.status === 405) && opts.listApi) throw new Error(TOO_OLD);
    if (res.status >= 400) throw new KomgaHttpError(res.status, `Komga answered HTTP ${res.status} for ${path}`);
    if (res.status === 204 || res.body.trim() === "") return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new Error(`The server at ${this.server()} didn't answer like Komga. Check the address.`);
    }
  }
}

export default defineBridge((host) => new KomgaBridge(host));
