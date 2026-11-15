/**
 * Kavita, through its REST API, signed in with the user's API key.
 *
 * - The API key is traded for a session token (`/api/Plugin/authenticate`, which every Kavita
 *   since 0.5 has) and the token is renewed when Kavita turns it down. Images can't send the
 *   token: Kavita's image endpoints take the key as an `apiKey` query parameter, which the image
 *   interceptor adds at fetch time, so the key is in no URL that is stored or shown.
 * - Ids are Kavita's own series and chapter ids, so they survive the server changing address.
 * - Chapters follow Kavita's shape: chapters inside volumes, loose chapters (a comic library's
 *   issues), then specials. A volume Kavita holds as one file is one chapter, named for the volume.
 * - Reading state syncs both ways (capability "read-sync").
 */
import {
  BridgeBase,
  type BridgeInfo,
  type Chapter,
  type HostCapabilities,
  type HttpMethod,
  type HttpResponse,
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
import { hostnameOf, normalizeServerUrl, serverImages } from "./core/server.ts";

const SETTINGS = defineSettings([
  {
    type: "string",
    key: "serverUrl",
    label: "Server address",
    description: "Kavita's address, as you open it in a browser. Kavita's OPDS URL works too.",
    placeholder: "http://192.168.1.5:5000",
    required: true,
  },
  {
    type: "string",
    key: "apiKey",
    label: "API key",
    description: "In Kavita: User settings → Auth keys. Not needed if you pasted the OPDS URL above.",
    secret: true,
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

const PAGE_SIZE = 24;
const MAX_COLLECTION_LISTS = 20;
/** How long the lists are reused: soon enough that On deck appears once you start reading. */
const LISTS_TTL_MS = 5 * 60 * 1000;
const PLUGIN_NAME = "Comical";
/** Kavita's number for "none": a loose chapter's volume, a whole-volume file's chapter. */
const NONE = -100000;

/** Kavita's web routes and API prefixes: a pasted link is cut back to the server's own address. */
const SERVER_PATH =
  /\/(?:api|library|home|login|registration|all-series|want-to-read|collections|lists|bookmarks|settings|browse|preferences|announcements|person|all-filters|book|pdf|manga)(?:\/.*)?$/i;

/**
 * The server's base address from what a user typed or pasted, and the API key in it when it is
 * Kavita's OPDS URL (`…/api/opds/<key>`).
 */
export function kavitaBase(raw: string): { base: string; apiKey?: string } {
  const url = new URL(normalizeServerUrl(raw));
  const key = /\/api\/opds\/([^/?#]+)/i.exec(url.pathname)?.[1];
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(SERVER_PATH, "");
  const base = url.toString().replace(/\/+$/, "");
  return key ? { base, apiKey: decodeURIComponent(key) } : { base };
}

// ---- Kavita's API, as much of it as the bridge reads ----

interface KSeries {
  id: number;
  name: string;
  originalName?: string | null;
  localizedName?: string | null;
  libraryId: number;
  format: number;
  pages: number;
  pagesRead: number;
}
interface KPerson {
  name?: string | null;
}
interface KMetadata {
  summary?: string | null;
  genres?: Array<{ title?: string | null }>;
  tags?: Array<{ title?: string | null }>;
  writers?: KPerson[];
  pencillers?: KPerson[];
  inkers?: KPerson[];
  colorists?: KPerson[];
  coverArtists?: KPerson[];
  publishers?: KPerson[];
  ageRating?: number;
  releaseYear?: number;
  language?: string | null;
  publicationStatus?: number;
}
interface KChapter {
  id: number;
  range?: string | null;
  number?: string | null;
  minNumber: number;
  pages: number;
  pagesRead: number;
  isSpecial: boolean;
  title?: string | null;
  titleName?: string | null;
  releaseDate?: string | null;
}
interface KVolume {
  id: number;
  name?: string | null;
  minNumber: number;
  chapters: KChapter[];
}
interface KSeriesDetail {
  volumes: KVolume[];
  chapters: KChapter[];
  specials: KChapter[];
}
interface KChapterInfo {
  pages: number;
  seriesFormat: number;
  seriesId: number;
}
interface KSearch {
  series: Array<{ seriesId: number; name: string }>;
}
interface KLibrary {
  id: number;
  name: string;
}
interface KCollection {
  id: number;
  title: string;
}
interface KAuth {
  username: string;
  token: string;
}

const FORMAT_EPUB = 3;
const FORMAT_PDF = 4;

/** A series filter that matches everything, sorted; `statements` narrow it. */
function filter(statements: Array<{ comparison: number; field: number; value: string }> = [], sortField = 1, asc = true) {
  return { statements, combination: 1, sortOptions: { sortField, isAscending: asc }, limitTo: 0 };
}
const FIELD_LIBRARIES = 19;
const EQUAL = 0;

const STATUS: Record<number, SeriesInfo["status"]> = {
  0: "ongoing",
  1: "hiatus",
  2: "completed",
  3: "cancelled",
  4: "completed",
};

/** Kavita's age ratings, from Early Childhood (2) to X18+ (14). */
function contentRating(age: number | undefined): SeriesInfo["contentRating"] {
  if (age === undefined || age < 2) return undefined;
  if (age >= 12) return "adult";
  return age >= 9 ? "mature" : "everyone";
}

const people = (...groups: Array<KPerson[] | undefined>): string[] => [
  ...new Set(groups.flatMap((g) => g ?? []).map((p) => p.name?.trim() ?? "").filter((n) => n.length > 0)),
];
const titles = (items: Array<{ title?: string | null }> | undefined): string[] => [
  ...new Set((items ?? []).map((t) => t.title?.trim() ?? "").filter((t) => t.length > 0)),
];

/** A date Kavita sends, or undefined for its "no date" (year 1). */
function dateOf(value: string | null | undefined): number | undefined {
  if (!value || value.startsWith("0001-")) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

class KavitaBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo;
  private readonly base: string | undefined;
  private readonly apiKey: string | undefined;
  private token: Promise<KAuth> | undefined;
  private listsMemo: { lists: Promise<SeriesList[]>; until: number } | undefined;

  constructor(host: HostCapabilities) {
    super(host);
    const raw = this.setting("serverUrl");
    let parsed: { base: string; apiKey?: string } | undefined;
    try {
      parsed = raw ? kavitaBase(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    this.base = parsed?.base;
    this.apiKey = this.setting("apiKey")?.trim() || parsed?.apiKey;

    const images = serverImages(this.base, this.apiKey !== undefined);
    this.info = {
      id: "porksphere.kavita",
      name: "Kavita",
      version: "0.1.0",
      contractVersion: "2.1.0",
      languages: ["multi"],
      nsfw: false,
      capabilities: ["lists", "search", "settings", "read-sync"],
      rateLimit: { maxConcurrent: 6 },
      ...(images ? { images } : {}),
      ...(this.base ? { linkHosts: [hostnameOf(this.base)] } : {}),
    };
  }

  // ---- Settings ----

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  loadSettings(): Promise<SettingsForm> {
    const [serverUrl, apiKey] = SETTINGS;
    const warning = insecureCredentialsWarning(this.base, this.apiKey !== undefined)?.replace(
      "your username and password are",
      "your API key is",
    );
    return Promise.resolve({
      sections: [
        { title: "Server", items: [serverUrl] },
        { title: "Sign-in", items: [apiKey], ...(warning ? { footer: warning } : {}) },
        { items: [{ type: "action", key: "test", label: "Test connection" }] },
      ],
    });
  }

  async runSettingAction(key: string): Promise<SettingActionResult> {
    if (key !== "test") throw new Error(`unknown setting action: ${key}`);
    if (!this.base) return { ok: false, message: "Enter Kavita's address first." };
    try {
      this.token = undefined;
      const auth = await this.session();
      const version = await this.request({ url: this.url(`/api/Plugin/version?apiKey=${encodeURIComponent(this.apiKey!)}`) })
        .then((r) => (r.status === 200 ? r.body.replace(/"/g, "").trim() : ""))
        .catch(() => "");
      return { ok: true, message: `Signed in to Kavita${version ? ` ${version}` : ""} as ${auth.username}.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message: parseLoginRequired(message)?.reason ?? message };
    }
  }

  /** Kavita's images take the key as a query parameter: added here, at fetch time, and never stored. */
  interceptImageRequest(url: string): Promise<ImageRequest> {
    if (!this.apiKey || /[?&]apiKey=/.test(url)) return Promise.resolve({ url });
    const sep = url.includes("?") ? "&" : "?";
    return Promise.resolve({ url: `${url}${sep}apiKey=${encodeURIComponent(this.apiKey)}` });
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
    const fixed: Array<[string, string]> = [
      ["on-deck", "On deck"],
      ["recently-added", "Recently added"],
    ];
    const [libraries, collections, ...filled] = await Promise.all([
      this.api<KLibrary[]>("GET", "/api/Library/libraries"),
      this.api<KCollection[]>("GET", "/api/Collection").catch(() => [] as KCollection[]),
      // Left out while empty (a new reader's On deck): one item says whether there is anything.
      ...fixed.map(([id]) => this.listPage(id, 1, 1).then((p) => p.series.length > 0)),
    ]);
    return [
      ...fixed
        .filter((_, i) => filled[i])
        .map(([id, name]): SeriesList => ({ id, name, layout: "carousel", featured: true })),
      ...libraries.map((l): SeriesList => ({ id: `library:${l.id}`, name: l.name, description: "Library", layout: "grid" })),
      ...collections
        .slice(0, MAX_COLLECTION_LISTS)
        .map((c): SeriesList => ({ id: `collection:${c.id}`, name: c.title, description: "Collection", layout: "grid" })),
    ];
  }

  async getListItems(listId: string, req?: ListRequest): Promise<PagedResults<SeriesEntry>> {
    const page = req?.cursor ? Number(req.cursor) : 1;
    if (!Number.isInteger(page) || page < 1) throw new Error(`bad cursor: ${req?.cursor}`);
    return this.cards(await this.listPage(listId, page, PAGE_SIZE));
  }

  /** One page of a list: its series and whether more follow. `page` is 1-based, as Kavita's is. */
  private async listPage(listId: string, page: number, size: number): Promise<{ series: KSeries[]; next?: number }> {
    const paging = `PageNumber=${page}&PageSize=${size}`;
    switch (listId) {
      case "on-deck":
        return this.paged("POST", `/api/Series/on-deck?${paging}`, {});
      case "recently-added":
        return this.paged("POST", `/api/Series/recently-added-v2?${paging}`, filter([], 2, false));
    }
    const [kind, id] = listId.split(":", 2);
    if (kind === "library" && id && /^\d+$/.test(id)) {
      return this.paged("POST", `/api/Series/all-v2?${paging}`, filter([{ comparison: EQUAL, field: FIELD_LIBRARIES, value: id }]));
    }
    if (kind === "collection" && id && /^\d+$/.test(id)) {
      return this.paged("GET", `/api/Series/series-by-collection?collectionId=${id}&${paging}`);
    }
    throw new Error(`unknown list: ${listId}`);
  }

  // ---- Search ----

  async getSearchResults(req: SearchRequest): Promise<PagedResults<SeriesEntry>> {
    const text = req.text.trim();
    if (!text) {
      const page = req.cursor ? Number(req.cursor) : 1;
      return this.cards(await this.paged("POST", `/api/Series/all-v2?PageNumber=${page}&PageSize=${PAGE_SIZE}`, filter()));
    }
    const found = await this.api<KSearch>(
      "GET",
      `/api/Search/search?queryString=${encodeURIComponent(text)}&includeChapterAndFiles=false`,
    );
    return {
      items: found.series.map((s) => ({
        id: String(s.seriesId),
        title: s.name,
        thumbnailUrl: this.url(`/api/Image/series-cover?seriesId=${s.seriesId}`),
      })),
    };
  }

  // ---- Series ----

  async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const id = this.numericId(seriesId);
    const [s, m] = await Promise.all([
      this.api<KSeries>("GET", `/api/Series/${id}`, undefined, { gone: true }),
      this.api<KMetadata | undefined>("GET", `/api/Series/metadata?seriesId=${id}`),
    ]);
    const writers = people(m?.writers);
    const artists = people(m?.pencillers, m?.inkers, m?.colorists, m?.coverArtists);
    const credited = writers.length > 0 ? writers : artists;
    const genres = titles(m?.genres);
    const tags = titles(m?.tags);
    const publisher = people(m?.publishers)[0];
    const altTitles = [...new Set([s.localizedName, s.originalName].map((t) => t?.trim() ?? ""))].filter(
      (t) => t.length > 0 && t !== s.name,
    );
    const status = m?.publicationStatus !== undefined ? STATUS[m.publicationStatus] : undefined;
    const rating = contentRating(m?.ageRating);
    const infoCells = [
      ...(publisher ? [{ label: "Publisher", value: publisher.slice(0, 80) }] : []),
      ...(m?.releaseYear && m.releaseYear > 0 ? [{ label: "Released", value: String(m.releaseYear) }] : []),
      { label: "Pages", value: String(s.pages) },
    ];
    return {
      id: String(s.id),
      title: s.name,
      thumbnailUrl: this.url(`/api/Image/series-cover?seriesId=${s.id}`),
      ...(altTitles.length ? { altTitles } : {}),
      ...(credited.length ? { author: credited.join(", "), authors: credited.map((name) => ({ name })) } : {}),
      ...(artists.length && writers.length ? { artist: artists.join(", "), artists: artists.map((name) => ({ name })) } : {}),
      ...(m?.summary?.trim() ? { description: m.summary.trim() } : {}),
      ...(status ? { status } : {}),
      ...(rating ? { contentRating: rating } : {}),
      ...(m?.language?.trim() ? { languages: [m.language.trim()] } : {}),
      tagGroups: [
        ...(genres.length ? [{ label: "Genres", kind: "genre" as const, tags: genres }] : []),
        ...(tags.length ? [{ label: "Tags", kind: "other" as const, tags }] : []),
      ],
      infoCells,
      shareUrl: this.url(`/library/${s.libraryId}/series/${s.id}`),
    };
  }

  override async getChapters(seriesId: string): Promise<Chapter[]> {
    return this.chapterList(await this.detail(seriesId)).map(({ chapter, volume }) => this.chapterOf(chapter, volume));
  }

  override async getChapterPages(_seriesId: string, chapterId: string): Promise<Page[]> {
    const id = this.numericId(chapterId);
    const info = await this.api<KChapterInfo>("GET", `/api/Reader/chapter-info?chapterId=${id}`);
    if (info.seriesFormat === FORMAT_EPUB) {
      throw new Error("This is a text EPUB: Comical reads comics page by page, and Kavita has no pages to give for it.");
    }
    const pdf = info.seriesFormat === FORMAT_PDF ? "&extractPdf=true" : "";
    return Array.from({ length: info.pages }, (_, index) => ({
      index,
      imageUrl: this.url(`/api/Reader/image?chapterId=${id}&page=${index}${pdf}`),
    }));
  }

  // ---- Read-sync ----

  async getReadChapters(seriesId: string): Promise<string[]> {
    return this.chapterList(await this.detail(seriesId))
      .filter(({ chapter }) => chapter.pages > 0 && chapter.pagesRead >= chapter.pages)
      .map(({ chapter }) => String(chapter.id));
  }

  override async markChapterRead(seriesId: string, chapterId: string): Promise<void> {
    await this.api("POST", "/api/Reader/mark-multiple-read", this.readBody(seriesId, chapterId));
  }

  override async markChapterUnread(seriesId: string, chapterId: string): Promise<void> {
    await this.api("POST", "/api/Reader/mark-multiple-unread", this.readBody(seriesId, chapterId));
  }

  // ---- Links ----

  resolveUrl(url: string): Promise<LinkTarget | null> {
    if (!this.base) return Promise.resolve(null);
    try {
      const u = new URL(url);
      const base = new URL(this.base);
      if (u.host !== base.host || !u.pathname.startsWith(base.pathname)) return Promise.resolve(null);
      const path = u.pathname.slice(base.pathname.replace(/\/$/, "").length);
      const m = /^\/library\/\d+\/series\/(\d+)(?:\/(?:chapter|manga|book|pdf)\/(\d+))?/.exec(path);
      if (!m?.[1]) return Promise.resolve(null);
      return Promise.resolve(m[2] ? { seriesId: m[1], chapterId: m[2] } : { seriesId: m[1] });
    } catch {
      return Promise.resolve(null);
    }
  }

  // ---- Internals ----

  private server(): string {
    if (!this.base) throw new Error('required setting "serverUrl" is not configured');
    return this.base;
  }

  private url(path: string): string {
    return this.server() + path;
  }

  private numericId(id: string): number {
    if (!/^\d+$/.test(id)) throw new Error(`not a Kavita id: ${id}`);
    return Number(id);
  }

  private readBody(seriesId: string, chapterId: string) {
    return {
      seriesId: this.numericId(seriesId),
      volumeIds: [],
      chapterIds: [this.numericId(chapterId)],
      generateReadingSession: false,
    };
  }

  private async detail(seriesId: string): Promise<KSeriesDetail> {
    return this.api<KSeriesDetail>("GET", `/api/Series/series-detail?seriesId=${this.numericId(seriesId)}`, undefined, {
      gone: true,
    });
  }

  /** Every chapter once, in reading order: volumes' chapters, loose chapters, then specials. */
  private chapterList(d: KSeriesDetail): Array<{ chapter: KChapter; volume?: KVolume }> {
    const seen = new Set<number>();
    const out: Array<{ chapter: KChapter; volume?: KVolume }> = [];
    const add = (chapter: KChapter, volume?: KVolume) => {
      if (seen.has(chapter.id)) return;
      seen.add(chapter.id);
      out.push(volume && volume.minNumber !== NONE ? { chapter, volume } : { chapter });
    };
    for (const v of d.volumes ?? []) for (const c of v.chapters ?? []) add(c, v);
    for (const c of d.chapters ?? []) add(c);
    for (const c of d.specials ?? []) add(c);
    return out;
  }

  private chapterOf(c: KChapter, volume: KVolume | undefined): Chapter {
    const hasNumber = !c.isSpecial && c.minNumber !== NONE;
    // Kavita names most volumes by their number alone ("1").
    const label = volume?.name?.trim() || String(volume?.minNumber ?? "");
    const volumeName = volume ? (/^[\d.]+$/.test(label) ? `Volume ${label}` : label) : undefined;
    const name =
      c.titleName?.trim() ||
      (!hasNumber && volumeName && !c.isSpecial ? volumeName : undefined) ||
      c.title?.trim() ||
      (hasNumber ? `Chapter ${c.range ?? c.minNumber}` : (c.range ?? "Special"));
    const published = dateOf(c.releaseDate);
    return {
      id: String(c.id),
      name,
      ...(hasNumber ? { number: c.minNumber } : {}),
      ...(volume ? { volume: volume.minNumber } : {}),
      ...(c.pages > 0 ? { pageCount: c.pages } : {}),
      ...(published !== undefined ? { publishedAt: published } : {}),
    };
  }

  private cards(page: { series: KSeries[]; next?: number }): PagedResults<SeriesEntry> {
    return {
      items: page.series.map((s) => ({
        id: String(s.id),
        title: s.name,
        thumbnailUrl: this.url(`/api/Image/series-cover?seriesId=${s.id}`),
      })),
      ...(page.next ? { nextCursor: String(page.next) } : {}),
    };
  }

  /** A paged Kavita endpoint: the body is the page, the `Pagination` header says if more follow. */
  private async paged(method: HttpMethod, path: string, body?: unknown): Promise<{ series: KSeries[]; next?: number }> {
    const res = await this.call(method, path, body);
    const series = this.json<KSeries[]>(res);
    const header = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "pagination")?.[1];
    let next: number | undefined;
    try {
      const p = header ? (JSON.parse(header) as { currentPage: number; totalPages: number }) : undefined;
      if (p && p.currentPage < p.totalPages) next = p.currentPage + 1;
    } catch {
      next = undefined;
    }
    return next ? { series, next } : { series };
  }

  /** The session token for the API key, fetched once and again when Kavita turns it down. */
  private session(): Promise<KAuth> {
    if (!this.apiKey) {
      return Promise.reject(new Error(loginRequiredMessage("apiKey", "Kavita needs an API key.")));
    }
    this.token ??= this.request({
      url: this.url(`/api/Plugin/authenticate?apiKey=${encodeURIComponent(this.apiKey)}&pluginName=${PLUGIN_NAME}`),
      method: "POST",
      headers: { Accept: "application/json" },
    }).then((res) => {
      if (res.status === 401 || res.status === 403) {
        throw new Error(loginRequiredMessage("apiKey", "Kavita turned down this API key."));
      }
      if (res.status >= 400) throw new Error(`Kavita answered HTTP ${res.status} when signing in`);
      const auth = this.json<KAuth>(res);
      if (!auth?.token) throw new Error(`The server at ${this.server()} didn't answer like Kavita. Check the address.`);
      return auth;
    });
    const pending = this.token;
    pending.catch(() => {
      if (this.token === pending) this.token = undefined;
    });
    return pending;
  }

  private async call(method: HttpMethod, path: string, body?: unknown, retried = false): Promise<HttpResponse> {
    const { token } = await this.session();
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.request({
      url: this.url(path),
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && !retried) {
      this.token = undefined; // expired: sign in again once
      return this.call(method, path, body, true);
    }
    if (res.status === 401) throw new Error(loginRequiredMessage("apiKey", "Kavita turned down this API key."));
    return res;
  }

  /**
   * One call to Kavita's API, parsed. `gone` marks a series lookup, whose 404 (or the 400
   * "Series does not exist") means the series was removed.
   */
  private async api<T = unknown>(method: HttpMethod, path: string, body?: unknown, opts: { gone?: boolean } = {}): Promise<T> {
    const res = await this.call(method, path, body);
    if (opts.gone && (res.status === 404 || (res.status === 400 && /does not exist/i.test(res.body)))) {
      throw new Error(seriesGoneMessage("removed from Kavita"));
    }
    if (res.status === 403) throw new Error("Kavita refused this request: the account isn't allowed to do it.");
    if (res.status === 404) throw new Error(`Kavita has nothing at ${path.split("?")[0]}`);
    if (res.status >= 400) throw new Error(`Kavita answered HTTP ${res.status} for ${path.split("?")[0]}`);
    return this.json<T>(res);
  }

  private json<T>(res: HttpResponse): T {
    if (res.status === 204 || res.body.trim() === "") return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new Error(`The server at ${this.server()} didn't answer like Kavita. Check the address.`);
    }
  }
}

export default defineBridge((host) => new KavitaBridge(host));
