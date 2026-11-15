/**
 * Suwayomi (Suwayomi-Server v2), through its GraphQL API.
 *
 * Suwayomi is itself a reader for many sources (its installed extensions, and the Local source of
 * files on the server). The bridge shows what the user has there:
 *
 * - Lists: Recently updated (new chapters of library series), the library (one list per
 *   category, when there are categories), then each installed source's popular titles, searchable
 *   within the source.
 * - Search covers the library and the installed sources, a page of each.
 * - Ids are Suwayomi's manga and chapter ids: server-scoped, stable across address changes.
 * - Reading state syncs both ways (capability "read-sync").
 *
 * Sign-in follows Suwayomi's auth modes: none, Basic auth, or UI login (the `login` mutation's
 * bearer token, renewed when it is turned down). Simple login (a browser session cookie) isn't
 * supported: the settings say to use Basic auth or UI login instead.
 */
import {
  BridgeBase,
  type BridgeInfo,
  type Chapter,
  type HostCapabilities,
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
    description: "Suwayomi's address, as you open it in a browser.",
    placeholder: "http://192.168.1.5:4567",
    required: true,
  },
  { type: "string", key: "username", label: "Username", description: "Leave empty if Suwayomi has no sign-in." },
  { type: "string", key: "password", label: "Password", secret: true },
]);
type Settings = InferSettings<typeof SETTINGS>;

const PAGE_SIZE = 24;
const MAX_SOURCE_LISTS = 20;
/** Sources searched at once from the search box; each source's own list searches just it. */
const MAX_SEARCH_SOURCES = 8;
/** Chapters looked at for Recently updated, before they are folded into one card per series. */
const RECENT_CHAPTERS = 60;
const LISTS_TTL_MS = 5 * 60 * 1000;
const LOCAL_SOURCE = "0";

/** Suwayomi's web routes and API prefix: a pasted link is cut back to the server's own address. */
const SERVER_PATH =
  /\/(?:api|library|manga|sources|browse|updates|history|settings|downloads|extensions|migrate|search|about|login)(?:\/.*)?$/i;

export function suwayomiBase(raw: string): string {
  const url = new URL(normalizeServerUrl(raw));
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(SERVER_PATH, "");
  return url.toString().replace(/\/+$/, "");
}

// ---- Suwayomi's API, as much of it as the bridge reads ----

interface SSource {
  id: string;
  displayName: string;
  lang: string;
  contentWarning: "SAFE" | "MIXED" | "NSFW";
}
interface SManga {
  id: number;
  title: string;
  thumbnailUrl?: string | null;
  author?: string | null;
  artist?: string | null;
  description?: string | null;
  genre?: string[];
  status?: string;
  realUrl?: string | null;
  initialized?: boolean;
  unreadCount?: number;
  source?: SSource | null;
}
interface SChapter {
  id: number;
  name: string;
  chapterNumber: number;
  scanlator?: string | null;
  uploadDate?: string;
  pageCount: number;
  isRead: boolean;
  sourceOrder: number;
  manga?: SManga;
}
interface SCategory {
  id: number;
  name: string;
  default: boolean;
  order: number;
}
interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

const MANGA_CARD = "id title thumbnailUrl unreadCount source { id displayName lang contentWarning }";
const MANGA_FULL = `${MANGA_CARD} author artist description genre status realUrl initialized`;
const CHAPTER = "id name chapterNumber scanlator uploadDate pageCount isRead sourceOrder";

const STATUS: Record<string, SeriesInfo["status"]> = {
  ONGOING: "ongoing",
  COMPLETED: "completed",
  PUBLISHING_FINISHED: "completed",
  CANCELLED: "cancelled",
  ON_HIATUS: "hiatus",
};

/** A Suwayomi call failed in a way the bridge can't put better. */
class SuwayomiError extends Error {}

/** Names in a comma-separated credit, once each. */
const credits = (value: string | null | undefined): string[] => [
  ...new Set((value ?? "").split(",").map((n) => n.trim()).filter((n) => n.length > 0)),
];

class SuwayomiBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo;
  private readonly base: string | undefined;
  private readonly username: string | undefined;
  private readonly password: string;
  /** How the server wants to be signed in to: unknown until a call says. */
  private mode: "basic" | "bearer" = "basic";
  private bearer: Promise<string> | undefined;
  private currentToken: string | undefined;
  private listsMemo: { lists: Promise<SeriesList[]>; until: number } | undefined;
  private sourcesMemo: Promise<SSource[]> | undefined;

  constructor(host: HostCapabilities) {
    super(host);
    const raw = this.setting("serverUrl");
    let base: string | undefined;
    try {
      base = raw ? suwayomiBase(raw) : undefined;
    } catch {
      base = undefined;
    }
    this.base = base;
    this.username = this.setting("username")?.trim() || undefined;
    this.password = this.setting("password") ?? "";

    const images = serverImages(base, this.username !== undefined);
    this.info = {
      id: "porksphere.suwayomi",
      name: "Suwayomi",
      version: "0.1.0",
      contractVersion: "2.1.0",
      languages: ["multi"],
      nsfw: false,
      capabilities: ["lists", "search", "settings", "read-sync"],
      cardSubtitles: true,
      rateLimit: { maxConcurrent: 4 },
      ...(images ? { images } : {}),
      ...(base ? { linkHosts: [hostnameOf(base)] } : {}),
    };
  }

  // ---- Settings ----

  getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  loadSettings(): Promise<SettingsForm> {
    const [serverUrl, username, password] = SETTINGS;
    const warning = insecureCredentialsWarning(this.base, this.username !== undefined);
    return Promise.resolve({
      sections: [
        { title: "Server", items: [serverUrl] },
        {
          title: "Sign-in",
          items: [username, password],
          footer:
            warning ??
            "For a Suwayomi with Basic auth or UI login. Simple login isn't supported: switch Suwayomi to " +
              "Basic auth or UI login to sign in from Comical.",
        },
        { items: [{ type: "action", key: "test", label: "Test connection" }] },
      ],
    });
  }

  async runSettingAction(key: string): Promise<SettingActionResult> {
    if (key !== "test") throw new Error(`unknown setting action: ${key}`);
    if (!this.base) return { ok: false, message: "Enter Suwayomi's address first." };
    try {
      const { aboutServer } = await this.gql<{ aboutServer: { name: string; version: string } }>(
        "{ aboutServer { name version } }",
      );
      const sources = await this.sources();
      return {
        ok: true,
        message: `Connected to ${aboutServer.name} ${aboutServer.version}, with ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, message: parseLoginRequired(message)?.reason ?? message };
    }
  }

  interceptImageRequest(url: string): Promise<ImageRequest> {
    return Promise.resolve(authorizedImage(url, this.authHeaders()));
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
    const [{ categories }, sources] = await Promise.all([
      this.gql<{ categories: { nodes: SCategory[] } }>("{ categories { nodes { id name default order } } }"),
      this.sources(),
    ]);
    const custom = categories.nodes.filter((c) => !c.default).sort((a, b) => a.order - b.order);
    const library: Array<[string, string]> = custom.length
      ? [["library:default", "Default"], ...custom.map((c): [string, string] => [`library:${c.id}`, c.name])]
      : [["library", "Library"]];
    // Recently updated and the library lists are left out while empty.
    const candidates: Array<[string, string]> = [["updated", "Recently updated"], ...library];
    const filled = await Promise.all(candidates.map(([id]) => this.listPage(id, 0, 1).then((p) => p.items.length > 0)));
    return [
      ...candidates
        .filter((_, i) => filled[i])
        .map(([id, name], i): SeriesList => ({ id, name, layout: i < 2 ? "carousel" : "grid", featured: i < 2 })),
      ...sources.slice(0, MAX_SOURCE_LISTS).map(
        (s): SeriesList => ({
          id: `source:${s.id}`,
          name: s.displayName,
          description: s.id === LOCAL_SOURCE ? "Files on the server" : "Popular",
          layout: "grid",
          searchable: true,
        }),
      ),
    ];
  }

  async getListItems(listId: string, req?: ListRequest): Promise<PagedResults<SeriesEntry>> {
    const page = req?.cursor ? Number(req.cursor) : 0;
    if (!Number.isInteger(page) || page < 0) throw new Error(`bad cursor: ${req?.cursor}`);
    const query = req?.query?.trim();
    if (query && listId.startsWith("source:")) return this.sourcePage(listId.slice(7), page, query);
    return this.listPage(listId, page, PAGE_SIZE);
  }

  /** One page of a list. `page` is a 0-based page number for every list but a source's (1-based). */
  private async listPage(listId: string, page: number, size: number): Promise<PagedResults<SeriesEntry>> {
    if (listId === "updated") return this.recentlyUpdated(size);
    if (listId === "library" || listId.startsWith("library:")) {
      const which = listId.slice(8);
      const filter: Record<string, unknown> = { inLibrary: { equalTo: true } };
      if (which === "default") filter.categoryId = { isNull: true };
      else if (which) {
        if (!/^\d+$/.test(which)) throw new Error(`unknown list: ${listId}`);
        filter.categoryId = { equalTo: Number(which) };
      }
      const { mangas } = await this.gql<{ mangas: { nodes: SManga[]; pageInfo: { hasNextPage: boolean } } }>(
        `query($filter: MangaFilterInput, $first: Int, $offset: Int) {
          mangas(filter: $filter, order: [{ by: TITLE }], first: $first, offset: $offset) {
            nodes { ${MANGA_CARD} } pageInfo { hasNextPage } } }`,
        { filter, first: size, offset: page * size },
      );
      return {
        items: mangas.nodes.map((m) => this.card(m, true)),
        ...(mangas.pageInfo.hasNextPage ? { nextCursor: String(page + 1) } : {}),
      };
    }
    if (listId.startsWith("source:")) return this.sourcePage(listId.slice(7), page);
    throw new Error(`unknown list: ${listId}`);
  }

  /** New chapters of library series, newest first, one card per series naming its newest chapter. */
  private async recentlyUpdated(size: number): Promise<PagedResults<SeriesEntry>> {
    const { chapters } = await this.gql<{ chapters: { nodes: SChapter[] } }>(
      `query($first: Int) { chapters(filter: { inLibrary: { equalTo: true } }, order: [{ by: FETCHED_AT, byType: DESC }],
        first: $first) { nodes { name manga { ${MANGA_CARD} } } } }`,
      { first: Math.max(size, size === 1 ? 1 : RECENT_CHAPTERS) },
    );
    const seen = new Set<number>();
    const items: SeriesEntry[] = [];
    for (const c of chapters.nodes) {
      if (!c.manga || seen.has(c.manga.id)) continue;
      seen.add(c.manga.id);
      items.push({ ...this.card(c.manga, false), subtitle: c.name });
      if (items.length >= size) break;
    }
    return { items };
  }

  /** A page of a source: its popular titles, or a search within it. Cursors are 0-based here too. */
  private async sourcePage(sourceId: string, page: number, query?: string): Promise<PagedResults<SeriesEntry>> {
    if (!/^-?\d+$/.test(sourceId)) throw new Error(`unknown list: source:${sourceId}`);
    const source = (await this.sources()).find((s) => s.id === sourceId);
    const { fetchSourceManga } = await this.gql<{ fetchSourceManga: { hasNextPage: boolean; mangas: SManga[] } }>(
      `mutation($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { hasNextPage mangas { ${MANGA_CARD} } } }`,
      { input: { source: sourceId, type: query ? "SEARCH" : "POPULAR", page: page + 1, ...(query ? { query } : {}) } },
    );
    return {
      items: fetchSourceManga.mangas.map((m) => this.card({ ...m, source: m.source ?? source ?? null }, false)),
      ...(fetchSourceManga.hasNextPage ? { nextCursor: String(page + 1) } : {}),
    };
  }

  // ---- Search ----

  async getSearchResults(req: SearchRequest): Promise<PagedResults<SeriesEntry>> {
    const text = req.text.trim();
    if (!text) return this.listPage("library", req.cursor ? Number(req.cursor) : 0, PAGE_SIZE);
    const sources = (await this.sources()).slice(0, MAX_SEARCH_SOURCES);
    const [library, ...fromSources] = await Promise.all([
      this.gql<{ mangas: { nodes: SManga[] } }>(
        `query($title: String) { mangas(filter: { inLibrary: { equalTo: true }, title: { includesInsensitive: $title } },
          order: [{ by: TITLE }], first: 50) { nodes { ${MANGA_CARD} } } }`,
        { title: text },
      ).then((r) => r.mangas.nodes),
      // A source that fails (offline, blocked) is left out of the results, not fatal.
      ...sources.map((s) => this.sourcePage(s.id, 0, text).catch(() => ({ items: [] as SeriesEntry[] }))),
    ]);
    const seen = new Set<string>();
    const items: SeriesEntry[] = [];
    for (const entry of [...library.map((m) => this.card(m, true)), ...fromSources.flatMap((r) => r.items)]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      items.push(entry);
    }
    return { items };
  }

  // ---- Series ----

  async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const id = this.numericId(seriesId);
    let m = (await this.gql<{ manga: SManga }>(`query($id: Int!) { manga(id: $id) { ${MANGA_FULL} } }`, { id }, { gone: "manga" })).manga;
    if (!m.initialized) {
      // Never opened on the server: ask its source for the details first.
      m = await this.fetchManga(id).catch(() => m);
    }
    const authors = credits(m.author);
    const artists = credits(m.artist).filter((a) => !authors.includes(a));
    const genres = [...new Set((m.genre ?? []).map((g) => g.trim()).filter((g) => g.length > 0))];
    const status = m.status ? STATUS[m.status] : undefined;
    const lang = m.source?.lang;
    return {
      id: String(m.id),
      title: m.title,
      ...(m.thumbnailUrl ? { thumbnailUrl: this.abs(m.thumbnailUrl) } : {}),
      ...(authors.length ? { author: authors.join(", "), authors: authors.map((name) => ({ name })) } : {}),
      ...(artists.length ? { artist: artists.join(", "), artists: artists.map((name) => ({ name })) } : {}),
      ...(m.description?.trim() ? { description: m.description.trim() } : {}),
      ...(status ? { status } : {}),
      ...(m.source?.contentWarning === "NSFW" ? { contentRating: "adult" as const } : {}),
      ...(lang && /^[a-z]{2}(-[A-Za-z]+)?$/.test(lang) ? { languages: [lang] } : {}),
      tagGroups: genres.length ? [{ label: "Genres", kind: "genre", tags: genres }] : [],
      ...(m.source ? { infoCells: [{ label: "Source", value: m.source.displayName.slice(0, 80) }] } : {}),
      ...(m.realUrl ? { shareUrl: m.realUrl } : {}),
    };
  }

  override async getChapters(seriesId: string): Promise<Chapter[]> {
    const id = this.numericId(seriesId);
    let chapters: SChapter[];
    try {
      chapters = await this.fetchChapters(id);
    } catch (e) {
      if (parseLoginRequired(String(e)) || String(e).includes("[series-gone]")) throw e;
      // The source is unreachable: what the server already knows is better than nothing.
      chapters = await this.storedChapters(id);
      if (chapters.length === 0) throw e;
    }
    return [...chapters].sort((a, b) => a.sourceOrder - b.sourceOrder).map((c) => this.chapterOf(c));
  }

  override async getChapterPages(_seriesId: string, chapterId: string): Promise<Page[]> {
    const { fetchChapterPages } = await this.gql<{ fetchChapterPages: { pages: string[] } }>(
      `mutation($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }`,
      { id: this.numericId(chapterId) },
    );
    return fetchChapterPages.pages.map((p, index) => ({ index, imageUrl: this.abs(p) }));
  }

  // ---- Read-sync ----

  async getReadChapters(seriesId: string): Promise<string[]> {
    const { chapters } = await this.gql<{ chapters: { nodes: Array<{ id: number }> } }>(
      `query($id: Int!) { chapters(condition: { mangaId: $id, isRead: true }) { nodes { id } } }`,
      { id: this.numericId(seriesId) },
    );
    return chapters.nodes.map((c) => String(c.id));
  }

  override async markChapterRead(_seriesId: string, chapterId: string): Promise<void> {
    await this.setRead(chapterId, true);
  }

  override async markChapterUnread(_seriesId: string, chapterId: string): Promise<void> {
    await this.setRead(chapterId, false);
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
    const m = /^\/manga\/(\d+)(?:\/chapter\/(\d+))?/.exec(path);
    if (!m?.[1]) return null;
    if (!m[2]) return { seriesId: m[1] };
    // The web reader's chapter number is the chapter's place in the source, not its id.
    const { chapters } = await this.gql<{ chapters: { nodes: Array<{ id: number }> } }>(
      `query($manga: Int!, $order: Int!) { chapters(condition: { mangaId: $manga, sourceOrder: $order }) { nodes { id } } }`,
      { manga: Number(m[1]), order: Number(m[2]) },
    );
    const chapter = chapters.nodes[0];
    return chapter ? { seriesId: m[1], chapterId: String(chapter.id) } : { seriesId: m[1] };
  }

  // ---- Internals ----

  private server(): string {
    if (!this.base) throw new Error('required setting "serverUrl" is not configured');
    return this.base;
  }

  private abs(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.server() + (path.startsWith("/") ? path : `/${path}`);
  }

  private numericId(id: string): number {
    if (!/^\d+$/.test(id)) throw new Error(`not a Suwayomi id: ${id}`);
    return Number(id);
  }

  private sources(): Promise<SSource[]> {
    this.sourcesMemo ??= this.gql<{ sources: { nodes: SSource[] } }>(
      "{ sources { nodes { id displayName lang contentWarning } } }",
    ).then(
      // The Local source first, then by name.
      (r) => [...r.sources.nodes].sort((a, b) => (a.id === LOCAL_SOURCE ? -1 : b.id === LOCAL_SOURCE ? 1 : a.displayName.localeCompare(b.displayName))),
    );
    const pending = this.sourcesMemo;
    pending.catch(() => {
      if (this.sourcesMemo === pending) this.sourcesMemo = undefined;
    });
    return pending;
  }

  private card(m: SManga, inLibrary: boolean): SeriesEntry {
    return {
      id: String(m.id),
      title: m.title,
      ...(m.thumbnailUrl ? { thumbnailUrl: this.abs(m.thumbnailUrl) } : {}),
      ...(inLibrary && m.source ? { subtitle: m.source.displayName } : {}),
      ...(inLibrary && m.unreadCount && m.unreadCount > 0
        ? { badges: [{ text: String(m.unreadCount), position: "top-right" as const, tone: "info" as const }] }
        : {}),
      ...(m.source?.contentWarning === "NSFW" ? { contentRating: "adult" as const } : {}),
    };
  }

  private chapterOf(c: SChapter): Chapter {
    const uploaded = c.uploadDate ? Number(c.uploadDate) : 0;
    return {
      id: String(c.id),
      name: c.name,
      // Suwayomi's -1 is "no number".
      ...(c.chapterNumber >= 0 ? { number: c.chapterNumber } : {}),
      ...(c.scanlator?.trim() ? { group: c.scanlator.trim() } : {}),
      ...(c.pageCount > 0 ? { pageCount: c.pageCount } : {}),
      ...(uploaded > 0 ? { publishedAt: uploaded } : {}),
    };
  }

  private async fetchManga(id: number): Promise<SManga> {
    const r = await this.gql<{ fetchMangaAndChapters: { manga: SManga } }>(
      `mutation($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchManga: true, fetchChapters: false }) { manga { ${MANGA_FULL} } } }`,
      { id },
    );
    return r.fetchMangaAndChapters.manga;
  }

  /** The source's chapter list, refreshed through the server. */
  private async fetchChapters(id: number): Promise<SChapter[]> {
    const r = await this.gql<{ fetchMangaAndChapters: { chapters: SChapter[] } }>(
      `mutation($id: Int!) { fetchMangaAndChapters(input: { id: $id, fetchManga: false, fetchChapters: true }) { chapters { ${CHAPTER} } } }`,
      { id },
      { gone: "fetchMangaAndChapters" },
    );
    return r.fetchMangaAndChapters.chapters;
  }

  private async storedChapters(id: number): Promise<SChapter[]> {
    const { chapters } = await this.gql<{ chapters: { nodes: SChapter[] } }>(
      `query($id: Int!) { chapters(condition: { mangaId: $id }) { nodes { ${CHAPTER} } } }`,
      { id },
    );
    return chapters.nodes;
  }

  private async setRead(chapterId: string, isRead: boolean): Promise<void> {
    await this.gql(
      `mutation($id: Int!, $read: Boolean!) { updateChapter(input: { id: $id, patch: { isRead: $read } }) { chapter { id } } }`,
      { id: this.numericId(chapterId), read: isRead },
    );
  }

  private authHeaders(): Record<string, string> | undefined {
    if (!this.username) return undefined;
    if (this.mode === "bearer") return this.currentToken ? { Authorization: `Bearer ${this.currentToken}` } : undefined;
    return { Authorization: basicAuth(this.username, this.password) };
  }

  /** A UI-login token for the username and password, fetched once and again when it is turned down. */
  private login(): Promise<string> {
    this.bearer ??= this.post(
      { query: "mutation($u: String!, $p: String!) { login(input: { username: $u, password: $p }) { accessToken } }", variables: { u: this.username, p: this.password } },
      {},
    ).then(({ status, data, errors }) => {
      const token = (data as { login?: { accessToken?: string } } | null)?.login?.accessToken;
      if (status === 401 || !token) {
        const reason = errors?.[0]?.message ?? "";
        throw new Error(
          loginRequiredMessage("username", /simple/i.test(reason) ? "Suwayomi uses simple login, which Comical can't sign in with: switch it to Basic auth or UI login." : "Suwayomi turned down this username and password."),
        );
      }
      this.currentToken = token;
      return token;
    });
    const pending = this.bearer;
    pending.catch(() => {
      if (this.bearer === pending) this.bearer = undefined;
    });
    return pending;
  }

  private async post(
    body: { query: string; variables?: Record<string, unknown> },
    headers: Record<string, string>,
  ): Promise<{ status: number; data: unknown; errors?: GraphQLError[] }> {
    const res = await this.request({
      url: this.url("/api/graphql"),
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) return { status: res.status, data: null };
    if (res.status >= 400 && res.body.trim() === "") throw new SuwayomiError(`Suwayomi answered HTTP ${res.status}`);
    try {
      const json = JSON.parse(res.body) as { data?: unknown; errors?: GraphQLError[] };
      return { status: res.status, data: json.data ?? null, ...(json.errors ? { errors: json.errors } : {}) };
    } catch {
      throw new SuwayomiError(`The server at ${this.server()} didn't answer like Suwayomi. Check the address.`);
    }
  }

  private url(path: string): string {
    return this.server() + path;
  }

  /**
   * One GraphQL call. Signs in as the server wants: nothing, Basic auth, or a UI-login token (tried
   * when Basic auth is turned down). `gone` names the field whose missing answer means the series
   * was removed.
   */
  private async gql<T>(query: string, variables?: Record<string, unknown>, opts: { gone?: string } = {}): Promise<T> {
    let used: { mode: "basic" | "bearer"; token: string | undefined } = { mode: this.mode, token: undefined };
    const send = async (): Promise<{ status: number; data: unknown; errors?: GraphQLError[] }> => {
      if (this.username && this.mode === "bearer") await this.login();
      used = { mode: this.mode, token: this.currentToken };
      return this.post({ query, ...(variables ? { variables } : {}) }, this.authHeaders() ?? {});
    };
    let res = await send();
    if (res.status === 401 && this.username) {
      // Basic auth turned down: the server uses UI login. A token turned down has run out: log in
      // again, unless a call running alongside already has.
      if (used.mode === "bearer" && this.currentToken === used.token) this.bearer = undefined;
      this.mode = "bearer";
      res = await send();
    }
    if (res.status === 401 || res.status === 403 || res.errors?.some((e) => /unauthori[sz]ed/i.test(e.message))) {
      throw new Error(
        loginRequiredMessage(
          "username",
          this.username ? "Suwayomi turned down this username and password." : "Suwayomi needs a username and password.",
        ),
      );
    }
    if (res.errors?.length) {
      const gone = opts.gone;
      if (gone && res.errors.some((e) => e.path?.[0] === gone && /null value|Collection is empty|not found/i.test(e.message))) {
        throw new Error(seriesGoneMessage("removed from Suwayomi"));
      }
      throw new SuwayomiError(`Suwayomi: ${res.errors[0]!.message.split("\n")[0]!.slice(0, 300)}`);
    }
    if (res.data === null) throw new SuwayomiError("Suwayomi sent no answer");
    return res.data as T;
  }
}

export default defineBridge((host) => new SuwayomiBridge(host));
