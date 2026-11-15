/**
 * LANraragi, through its API.
 *
 * - An archive is a series without chapters (capability "direct"): its pages are the archive's
 *   files. Ids are LANraragi's archive ids (a hash of the file), stable across address changes.
 * - Lists: Continue reading, New, Recently added, then each category with something in it.
 *   Search uses LANraragi's own filter syntax, so `artist:someone` works.
 * - Tags become credits and tag groups by namespace: `artist:` is the author, `parody:`,
 *   `character:` and `group:` get their own groups, the rest are tags.
 * - Reading state syncs (capability "read-sync") through the server's reading progress: finishing
 *   an archive sets its progress to the last page; one at the last page reads back as read.
 *
 * Most LANraragi servers can be read without a key; one in No-Fun Mode, or one that protects
 * progress, needs the API key, sent as LANraragi expects: `Authorization: Bearer <base64 key>`.
 */
import {
  BridgeBase,
  type BridgeInfo,
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
  type TagGroup,
  defineBridge,
  defineSettings,
  loginRequiredMessage,
  parseLoginRequired,
  seriesGoneMessage,
} from "@comical/sdk";
import { insecureCredentialsWarning } from "./core/network-safety.ts";
import { authorizedImage, hostnameOf, normalizeServerUrl, serverImages } from "./core/server.ts";

const SETTINGS = defineSettings([
  {
    type: "string",
    key: "serverUrl",
    label: "Server address",
    description: "LANraragi's address, as you open it in a browser.",
    placeholder: "http://192.168.1.5:3000",
    required: true,
  },
  {
    type: "string",
    key: "apiKey",
    label: "API key",
    description: "From LANraragi's settings, under Security. Needed in No-Fun Mode and to sync reading progress.",
    secret: true,
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

const MAX_CATEGORY_LISTS = 20;
const LISTS_TTL_MS = 5 * 60 * 1000;
/** Archive ids are a SHA-1 of the file. */
const ARCHIVE_ID = /^[0-9a-f]{40}$/;

/** LANraragi's web routes and API prefix: a pasted link is cut back to the server's own address. */
const SERVER_PATH = /\/(?:api|index|reader|edit|config|login|upload|batch|stats|logs|duplicates|tankoubon)(?:\/.*)?$/i;

export function lanraragiBase(raw: string): string {
  const url = new URL(normalizeServerUrl(raw));
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(SERVER_PATH, "");
  return url.toString().replace(/\/+$/, "");
}

// ---- LANraragi's API, as much of it as the bridge reads ----

interface LArchive {
  arcid: string;
  title: string;
  tags?: string;
  summary?: string;
  pagecount?: number;
  progress?: number;
  isnew?: boolean | string;
  lastreadtime?: number;
}
interface LSearch {
  data: LArchive[];
  recordsFiltered: number;
}
interface LCategory {
  id: string;
  name: string;
  archives: string[];
  search: string;
  pinned?: number | string;
}
interface LInfo {
  name: string;
  version: string;
  nofun_mode: boolean | number | string;
  total_archives?: number;
  archives_per_page?: number;
}

/** `namespace:value` tags, split. A tag without a namespace has namespace "". */
function parseTags(tags: string | undefined): Array<{ ns: string; value: string }> {
  return (tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const at = t.indexOf(":");
      return at > 0 ? { ns: t.slice(0, at).trim().toLowerCase(), value: t.slice(at + 1).trim() } : { ns: "", value: t };
    })
    .filter((t) => t.value.length > 0);
}

const valuesOf = (tags: Array<{ ns: string; value: string }>, ns: string): string[] => [
  ...new Set(tags.filter((t) => t.ns === ns).map((t) => t.value)),
];

/** Namespaces shown elsewhere, or that are bookkeeping rather than description. */
const NOT_TAGS = new Set(["artist", "parody", "character", "group", "language", "date_added", "timestamp", "source", "category"]);

function parses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

class LanraragiBridge extends BridgeBase<Settings> {
  readonly info: BridgeInfo;
  private readonly base: string | undefined;
  private readonly apiKey: string | undefined;
  private listsMemo: { lists: Promise<SeriesList[]>; until: number } | undefined;
  private pageSize: Promise<number> | undefined;

  constructor(host: HostCapabilities) {
    super(host);
    const raw = this.setting("serverUrl");
    let base: string | undefined;
    try {
      base = raw ? lanraragiBase(raw) : undefined;
    } catch {
      base = undefined;
    }
    this.base = base;
    this.apiKey = this.setting("apiKey")?.trim() || undefined;

    const images = serverImages(base, this.apiKey !== undefined);
    this.info = {
      id: "porksphere.lanraragi",
      name: "LANraragi",
      version: "0.1.0",
      contractVersion: "2.1.0",
      languages: ["multi"],
      nsfw: true,
      capabilities: ["direct", "lists", "search", "settings", "read-sync"],
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
    if (!this.base) return { ok: false, message: "Enter LANraragi's address first." };
    try {
      const info = await this.api<LInfo>("GET", "/api/info");
      if (typeof info?.version !== "string") {
        return { ok: false, message: `The server at ${this.base} didn't answer like LANraragi. Check the address.` };
      }
      // /api/shinobu answers only with a valid key: it tells a wrong key from a missing one.
      if (this.apiKey) await this.api("GET", "/api/shinobu");
      const archives = typeof info.total_archives === "number" ? `, ${info.total_archives} archives` : "";
      const keyNote = this.apiKey ? "" : truthy(info.nofun_mode) ? "" : " Add the API key to sync reading progress.";
      return { ok: true, message: `Connected to ${info.name} ${info.version}${archives}.${keyNote}` };
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
    const fixed: Array<[string, string]> = [
      ["continue", "Continue reading"],
      ["new", "New"],
      ["recent", "Recently added"],
    ];
    const [categories, ...filled] = await Promise.all([
      this.api<LCategory[]>("GET", "/api/categories").catch(() => [] as LCategory[]),
      ...fixed.map(([id]) => this.listPage(id, 0).then((p) => p.items.length > 0)),
    ]);
    // Pinned categories first; a static category with no archives is left out.
    const shown = categories
      .filter((c) => c.search.trim() !== "" || c.archives.length > 0)
      .sort((a, b) => Number(truthy(b.pinned)) - Number(truthy(a.pinned)));
    return [
      ...fixed
        .filter((_, i) => filled[i])
        .map(([id, name], i): SeriesList => ({ id, name, layout: "carousel", featured: i < 3 })),
      ...shown.slice(0, MAX_CATEGORY_LISTS).map(
        (c): SeriesList => ({ id: `category:${c.id}`, name: c.name, description: "Category", layout: "grid" }),
      ),
      { id: "all", name: "All archives", layout: "grid", searchable: true },
    ];
  }

  async getListItems(listId: string, req?: ListRequest): Promise<PagedResults<SeriesEntry>> {
    const start = req?.cursor ? Number(req.cursor) : 0;
    if (!Number.isInteger(start) || start < 0) throw new Error(`bad cursor: ${req?.cursor}`);
    return this.listPage(listId, start, req?.query?.trim());
  }

  /** A page of a list, from offset `start`. */
  private async listPage(listId: string, start: number, query?: string): Promise<PagedResults<SeriesEntry>> {
    switch (listId) {
      case "continue": {
        // Archives by when they were last read: the ones started and not finished.
        const page = await this.search({ start, sortby: "lastread", order: "desc" });
        const started = page.data.filter(
          (a) => (a.lastreadtime ?? 0) > 0 && (a.progress ?? 0) > 0 && (a.progress ?? 0) < (a.pagecount ?? 0),
        );
        return this.cards({ ...page, data: started }, start, page.data.length);
      }
      case "new":
        return this.cards(await this.search({ start, newonly: "true", sortby: "date_added", order: "desc" }), start);
      case "recent":
        return this.cards(await this.search({ start, sortby: "date_added", order: "desc" }), start);
      case "all":
        return this.cards(await this.search({ start, sortby: "title", order: "asc", ...(query ? { filter: query } : {}) }), start);
    }
    if (listId.startsWith("category:")) {
      const id = listId.slice(9);
      if (!/^[A-Za-z0-9_]+$/.test(id)) throw new Error(`unknown list: ${listId}`);
      return this.cards(await this.search({ start, category: id, sortby: "title", order: "asc" }), start);
    }
    throw new Error(`unknown list: ${listId}`);
  }

  // ---- Search ----

  async getSearchResults(req: SearchRequest): Promise<PagedResults<SeriesEntry>> {
    const start = req.cursor ? Number(req.cursor) : 0;
    const text = req.text.trim();
    return this.cards(await this.search({ start, sortby: "title", order: "asc", ...(text ? { filter: text } : {}) }), start);
  }

  // ---- Series ----

  async getSeriesDetails(seriesId: string): Promise<SeriesInfo> {
    const a = await this.metadata(seriesId);
    const tags = parseTags(a.tags);
    const artists = valuesOf(tags, "artist");
    const groups = valuesOf(tags, "group");
    const credited = artists.length > 0 ? artists : groups;
    const language = valuesOf(tags, "language")[0];
    const added = Number(valuesOf(tags, "date_added")[0]);
    const source = valuesOf(tags, "source")[0];
    const other = [
      ...new Set(tags.filter((t) => !NOT_TAGS.has(t.ns)).map((t) => (t.ns ? `${t.ns}:${t.value}` : t.value))),
    ];
    const tagGroups: TagGroup[] = [
      ...(valuesOf(tags, "parody").length ? [{ label: "Parody", tags: valuesOf(tags, "parody") }] : []),
      ...(valuesOf(tags, "character").length ? [{ label: "Characters", tags: valuesOf(tags, "character") }] : []),
      ...(artists.length && groups.length ? [{ label: "Group", tags: groups }] : []),
      ...(other.length ? [{ label: "Tags", kind: "other" as const, tags: other }] : []),
    ];
    const infoCells = [
      ...(a.pagecount ? [{ label: "Pages", value: String(a.pagecount) }] : []),
      ...(language ? [{ label: "Language", value: language.slice(0, 80) }] : []),
      ...(Number.isFinite(added) && added > 0
        ? [{ label: "Added", value: new Date(added * 1000).toISOString().slice(0, 10) }]
        : []),
    ];
    const sourceUrl = source ? (/^https?:\/\//i.test(source) ? source : `https://${source}`) : undefined;
    return {
      id: a.arcid,
      title: a.title,
      thumbnailUrl: this.url(`/api/archives/${a.arcid}/thumbnail`),
      ...(credited.length ? { author: credited.join(", "), authors: credited.map((name) => ({ name })) } : {}),
      ...(a.summary?.trim() ? { description: a.summary.trim() } : {}),
      contentRating: "adult",
      ...(a.pagecount ? { pageCount: a.pagecount } : {}),
      tagGroups,
      infoCells,
      shareUrl: sourceUrl && parses(sourceUrl) ? sourceUrl : this.url(`/reader?id=${a.arcid}`),
    };
  }

  override async getSeriesPages(seriesId: string): Promise<Page[]> {
    const id = this.archiveId(seriesId);
    const res = await this.call("GET", `/api/archives/${id}/files`);
    if (res.status >= 400) {
      await this.metadata(id); // an archive that is gone says so
      throw new Error(`LANraragi couldn't open this archive (HTTP ${res.status}).`);
    }
    const { pages } = this.json<{ pages: string[] }>(res.body);
    return pages.map((p, index) => ({ index, imageUrl: this.url(p.startsWith("/") ? p : `/${p}`) }));
  }

  // ---- Read-sync ----

  async getReadChapters(seriesId: string): Promise<string[]> {
    const a = await this.metadata(seriesId);
    return a.pagecount && (a.progress ?? 0) >= a.pagecount ? ["__direct__"] : [];
  }

  override async markChapterRead(seriesId: string, _chapterId: string): Promise<void> {
    const a = await this.metadata(seriesId);
    if (!a.pagecount) return;
    await this.progress(a.arcid, a.pagecount);
    // The archive has been read: it isn't new any more. Best-effort: it needs the API key.
    if (truthy(a.isnew)) await this.call("DELETE", `/api/archives/${a.arcid}/isnew`).catch(() => undefined);
  }

  override async markChapterUnread(seriesId: string, _chapterId: string): Promise<void> {
    // Progress below the current page needs `force`; 0 is "not started".
    await this.progress(this.archiveId(seriesId), 0, true);
  }

  // ---- Links ----

  resolveUrl(url: string): Promise<LinkTarget | null> {
    if (!this.base) return Promise.resolve(null);
    try {
      const u = new URL(url);
      const base = new URL(this.base);
      if (u.host !== base.host || !u.pathname.startsWith(base.pathname)) return Promise.resolve(null);
      const path = u.pathname.slice(base.pathname.replace(/\/$/, "").length);
      const id = u.searchParams.get("id")?.toLowerCase();
      if ((path === "/reader" || path === "/edit") && id && ARCHIVE_ID.test(id)) return Promise.resolve({ seriesId: id });
      return Promise.resolve(null);
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

  private archiveId(id: string): string {
    const lower = id.toLowerCase();
    if (!ARCHIVE_ID.test(lower)) throw new Error(`not a LANraragi archive id: ${id}`);
    return lower;
  }

  private authHeaders(): Record<string, string> | undefined {
    if (!this.apiKey) return undefined;
    const bytes = new TextEncoder().encode(this.apiKey);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return { Authorization: `Bearer ${btoa(binary)}` };
  }

  private async metadata(seriesId: string): Promise<LArchive> {
    const id = this.archiveId(seriesId);
    const res = await this.call("GET", `/api/archives/${id}/metadata`);
    if (res.status === 400 && /doesn.{0,6}t exist/i.test(res.body)) throw new Error(seriesGoneMessage("removed from LANraragi"));
    if (res.status >= 400) throw new Error(`LANraragi answered HTTP ${res.status} for this archive`);
    return this.json<LArchive>(res.body);
  }

  private async progress(id: string, page: number, force = false): Promise<void> {
    const res = await this.call("PUT", `/api/archives/${id}/progress/${page}${force ? "?force=1" : ""}`);
    if (res.status >= 400) {
      const body = this.json<{ error?: string }>(res.body);
      throw new Error(`LANraragi didn't save the reading progress${body?.error ? `: ${body.error}` : ""}`);
    }
  }

  /** The server's page size: search pages are always that long. */
  private archivesPerPage(): Promise<number> {
    this.pageSize ??= this.api<LInfo>("GET", "/api/info").then(
      (i) => (typeof i.archives_per_page === "number" && i.archives_per_page > 0 ? i.archives_per_page : 100),
      () => 100,
    );
    return this.pageSize;
  }

  private async search(params: Record<string, string | number>): Promise<LSearch & { pageSize: number }> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const [result, pageSize] = await Promise.all([this.api<LSearch>("GET", `/api/search?${qs}`), this.archivesPerPage()]);
    return { ...result, pageSize };
  }

  /** Search results as cards; the cursor is the next offset while there are more. */
  private cards(page: LSearch & { pageSize: number }, start: number, consumed = page.data.length): PagedResults<SeriesEntry> {
    const items = page.data.map((a): SeriesEntry => {
      const artist = valuesOf(parseTags(a.tags), "artist")[0];
      return {
        id: a.arcid,
        title: a.title,
        thumbnailUrl: this.url(`/api/archives/${a.arcid}/thumbnail`),
        ...(artist ? { subtitle: artist } : {}),
        ...(truthy(a.isnew) ? { badges: [{ text: "New", position: "top-right" as const, tone: "info" as const }] } : {}),
        contentRating: "adult",
      };
    });
    const next = start + Math.max(consumed, page.pageSize);
    return { items, ...(consumed > 0 && next < page.recordsFiltered ? { nextCursor: String(next) } : {}) };
  }

  private async call(method: HttpMethod, path: string) {
    const res = await this.request({
      url: this.url(path),
      method,
      headers: { Accept: "application/json", ...this.authHeaders() },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        loginRequiredMessage(
          "apiKey",
          this.apiKey ? "LANraragi turned down this API key." : "This LANraragi needs its API key.",
        ),
      );
    }
    return res;
  }

  private async api<T>(method: HttpMethod, path: string): Promise<T> {
    const res = await this.call(method, path);
    if (res.status >= 400) throw new Error(`LANraragi answered HTTP ${res.status} for ${path.split("?")[0]}`);
    return this.json<T>(res.body);
  }

  private json<T>(body: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`The server at ${this.server()} didn't answer like LANraragi. Check the address.`);
    }
  }
}

export default defineBridge((host) => new LanraragiBridge(host));
