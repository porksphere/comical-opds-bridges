/**
 * A fake Komga, served in-process. Its JSON has the shapes a live Komga 26.04 answers with (captured
 * from one), trimmed to the fields that matter, and it keeps reading progress so read-sync
 * round-trips. It understands the search-condition DSL the bridge sends: `seriesId`, `libraryId`
 * and `readStatus` conditions, alone or under `allOf`, and `fullTextSearch`.
 */
import type { HttpRequest, HttpResponse } from "@comical/sdk";

export const LIB_MANGA = "0LIBMANGA0001";
export const LIB_COMICS = "0LIBCOMICS001";
export const LIB_OFFLINE = "0LIBOFFLINE01";
export const SERIES_A = "0SERIESA00001";
export const SERIES_B = "0SERIESB00001";
export const SERIES_EPUB = "0SERIESEPUB01";
export const BOOK = (series: string, n: number): string => `${series.slice(0, 9)}BK${String(n).padStart(2, "0")}`;
/** Comics holds this many filler series, so its list pages. */
export const FILLER = 30;

interface Book {
  id: string;
  seriesId: string;
  title: string;
  number: number;
  pages: number;
  mediaType: string;
  profile: string;
  status: string;
  deleted?: boolean;
  releaseDate?: string;
  pageType?: string;
}
interface Series {
  id: string;
  libraryId: string;
  title: string;
  oneshot?: boolean;
  metadata?: Record<string, unknown>;
  authors?: Array<{ name: string; role: string }>;
}

const authors = [
  { name: "Jane Writer", role: "writer" },
  { name: "Ann Artist", role: "penciller" },
  { name: "Ann Artist", role: "inker" },
  { name: "Cole Ours", role: "colorist" },
];

const SERIES: Series[] = [
  {
    id: SERIES_A,
    libraryId: LIB_MANGA,
    title: "Test Series A",
    authors,
    metadata: {
      status: "ENDED",
      summary: "A series about tests.",
      readingDirection: "RIGHT_TO_LEFT",
      publisher: "Fixture Press",
      ageRating: 16,
      language: "ja",
      genres: ["Action", "Comedy"],
      tags: ["robots"],
      totalBookCount: 5,
      alternateTitles: [{ label: "Japanese", title: "テスト A" }],
    },
  },
  { id: SERIES_B, libraryId: LIB_MANGA, title: "Test Series B", oneshot: true },
  { id: SERIES_EPUB, libraryId: LIB_MANGA, title: "A Novel" },
  ...Array.from({ length: FILLER }, (_, i) => ({
    id: `0FILLER${String(i).padStart(6, "0")}`,
    libraryId: LIB_COMICS,
    title: `Filler ${String(i).padStart(2, "0")}`,
  })),
];

const BOOKS: Book[] = [
  { id: BOOK(SERIES_A, 1), seriesId: SERIES_A, title: "Volume 1", number: 1, pages: 4, mediaType: "application/zip", profile: "DIVINA", status: "READY", releaseDate: "2024-05-01" },
  { id: BOOK(SERIES_A, 2), seriesId: SERIES_A, title: "Volume 2", number: 2, pages: 3, mediaType: "application/zip", profile: "DIVINA", status: "READY", pageType: "image/avif" },
  { id: BOOK(SERIES_A, 3), seriesId: SERIES_A, title: "Volume 3", number: 3, pages: 0, mediaType: "application/zip", profile: "DIVINA", status: "ERROR" },
  { id: BOOK(SERIES_A, 9), seriesId: SERIES_A, title: "Removed", number: 9, pages: 2, mediaType: "application/zip", profile: "DIVINA", status: "READY", deleted: true },
  { id: BOOK(SERIES_B, 1), seriesId: SERIES_B, title: "Test Series B", number: 1, pages: 2, mediaType: "application/zip", profile: "DIVINA", status: "READY" },
  { id: BOOK(SERIES_EPUB, 1), seriesId: SERIES_EPUB, title: "Chapter Book", number: 1, pages: 0, mediaType: "application/epub+zip", profile: "EPUB", status: "READY" },
];

function seriesDto(s: Series, progress: Map<string, { page: number; completed: boolean }>) {
  const books = BOOKS.filter((b) => b.seriesId === s.id && !b.deleted);
  const read = books.filter((b) => progress.get(b.id)?.completed).length;
  const inProgress = books.filter((b) => progress.has(b.id) && !progress.get(b.id)!.completed).length;
  return {
    id: s.id,
    libraryId: s.libraryId,
    name: s.title,
    url: "",
    created: "2026-11-15T03:17:21Z",
    lastModified: "2026-11-15T03:17:21Z",
    booksCount: books.length,
    booksReadCount: read,
    booksUnreadCount: books.length - read - inProgress,
    booksInProgressCount: inProgress,
    metadata: {
      status: "ONGOING",
      title: s.title,
      titleSort: s.title,
      summary: "",
      readingDirection: "",
      publisher: "",
      ageRating: null,
      language: "",
      genres: [],
      tags: [],
      totalBookCount: null,
      sharingLabels: [],
      links: [],
      alternateTitles: [],
      ...s.metadata,
    },
    booksMetadata: {
      authors: s.authors ?? [],
      tags: ["from-books"],
      releaseDate: "2024-05-01",
      summary: "The first book's summary.",
      summaryNumber: "1",
    },
    deleted: false,
    oneshot: s.oneshot ?? false,
  };
}

function bookDto(b: Book, progress: Map<string, { page: number; completed: boolean }>) {
  const s = SERIES.find((x) => x.id === b.seriesId)!;
  const p = progress.get(b.id);
  return {
    id: b.id,
    seriesId: b.seriesId,
    seriesTitle: s.title,
    libraryId: s.libraryId,
    name: `${s.title} ${String(b.number).padStart(2, "0")}`,
    url: `${s.title}/${b.number}.cbz`,
    number: b.number,
    sizeBytes: 1238633,
    size: "1.2 MiB",
    media: {
      status: b.status,
      mediaType: b.mediaType,
      pagesCount: b.pages,
      comment: "",
      epubDivinaCompatible: false,
      epubIsKepub: false,
      mediaProfile: b.profile,
    },
    metadata: {
      title: b.title,
      summary: "",
      number: String(b.number),
      numberSort: b.number,
      releaseDate: b.releaseDate ?? null,
      authors: s.authors ?? [],
      tags: [],
      isbn: "",
      links: [],
    },
    readProgress: p ? { page: p.page, completed: p.completed, readDate: "2026-11-15T03:17:21Z" } : null,
    deleted: b.deleted ?? false,
    oneshot: s.oneshot ?? false,
  };
}

function paged<T>(all: T[], url: URL) {
  if (url.searchParams.get("unpaged") === "true") {
    return { content: all, last: true, number: 0, totalElements: all.length, totalPages: 1, first: true, empty: all.length === 0 };
  }
  const page = Number(url.searchParams.get("page") ?? 0);
  const size = Number(url.searchParams.get("size") ?? 20);
  const content = all.slice(page * size, page * size + size);
  const totalPages = Math.ceil(all.length / size);
  return {
    content,
    last: page >= totalPages - 1,
    number: page,
    size,
    totalElements: all.length,
    totalPages,
    first: page === 0,
    empty: content.length === 0,
  };
}

/** The leaf conditions of a search body, flattened out of `allOf`. */
function conditions(c: Record<string, unknown> | undefined): Record<string, string> {
  if (!c) return {};
  if (Array.isArray(c.allOf)) return Object.assign({}, ...c.allOf.map((x) => conditions(x as Record<string, unknown>)));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    const op = v as { operator: string; value: string };
    if (op.operator !== "is") throw new Error(`fixture doesn't understand ${k} ${op.operator}`);
    out[k] = op.value;
  }
  return out;
}

export interface KomgaServerOptions {
  /** Accepted credentials: an `Authorization` value and/or an API key. None means open access. */
  authorization?: string;
  apiKey?: string;
  roles?: string[];
  /** Behave like a Komga older than 1.19: no search-condition list endpoints. */
  old?: boolean;
  /** Refuse page streaming with 403, as for an account without the role. */
  noPageStreaming?: boolean;
}

export function komgaServer(origin = "http://komga.lan:25600", opts: KomgaServerOptions = {}) {
  const requests: HttpRequest[] = [];
  const progress = new Map<string, { page: number; completed: boolean }>();
  const json = (status: number, body: unknown): HttpResponse => ({
    url: "",
    status,
    statusText: String(status),
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });

  function route(req: HttpRequest, url: URL): HttpResponse {
    const method = req.method ?? "GET";
    const p = url.pathname;
    const body = req.body ? (JSON.parse(req.body) as { condition?: Record<string, unknown>; fullTextSearch?: string }) : {};
    const visibleBooks = BOOKS.filter((b) => !b.deleted);
    let m: RegExpExecArray | null;

    if (p === "/api/v2/users/me") return json(200, { id: "U1", email: "reader@example.com", roles: opts.roles ?? ["PAGE_STREAMING", "USER"] });
    if (p === "/api/v1/libraries") {
      return json(200, [
        { id: LIB_MANGA, name: "Manga", root: "/data/manga", unavailable: false },
        { id: LIB_COMICS, name: "Comics", root: "/data/comics", unavailable: false },
        { id: LIB_OFFLINE, name: "Offline", root: "/mnt/gone", unavailable: true },
      ]);
    }
    if (p === "/api/v1/collections") {
      return json(200, paged([{ id: "COLL1", name: "Favourites", ordered: true, seriesIds: [SERIES_B, SERIES_A] }], url));
    }
    if (p === "/api/v1/collections/COLL1/series") {
      return json(200, paged([SERIES_B, SERIES_A].map((id) => seriesDto(SERIES.find((s) => s.id === id)!, progress)), url));
    }
    if (p === "/api/v1/series/new") return json(200, paged(SERIES.slice(0, 3).map((s) => seriesDto(s, progress)), url));
    if (p === "/api/v1/series/updated") return json(200, paged([], url));
    if (p === "/api/v1/books/ondeck") {
      // The next book of a series that has read books and none in progress.
      const next = SERIES.flatMap((s) => {
        const books = visibleBooks.filter((b) => b.seriesId === s.id);
        if (!books.some((b) => progress.get(b.id)?.completed) || books.some((b) => progress.has(b.id) && !progress.get(b.id)!.completed)) return [];
        const b = books.find((x) => !progress.has(x.id));
        return b ? [b] : [];
      });
      return json(200, paged(next.map((b) => bookDto(b, progress)), url));
    }
    if (p === "/api/v1/series/list" && method === "POST") {
      if (opts.old) return json(404, { error: "Not Found" });
      const c = conditions(body.condition);
      const text = body.fullTextSearch?.toLowerCase();
      const found = SERIES.filter((s) => (!c.libraryId || s.libraryId === c.libraryId) && (!text || s.title.toLowerCase().includes(text)));
      return json(200, paged(found.map((s) => seriesDto(s, progress)), url));
    }
    if ((m = /^\/api\/v1\/series\/([^/]+)$/.exec(p))) {
      const s = SERIES.find((x) => x.id === m![1]);
      return s ? json(200, seriesDto(s, progress)) : json(404, { error: "Not Found" });
    }
    if (p === "/api/v1/books/list" && method === "POST") {
      if (opts.old) return json(404, { error: "Not Found" });
      const c = conditions(body.condition);
      // Like Komga, deleted books are listed (flagged); the bridge leaves them out.
      const found = BOOKS.filter((b) => {
        if (c.seriesId && b.seriesId !== c.seriesId) return false;
        const pr = progress.get(b.id);
        const status = !pr ? "UNREAD" : pr.completed ? "READ" : "IN_PROGRESS";
        return !c.readStatus || c.readStatus === status;
      });
      return json(200, paged(found.map((b) => bookDto(b, progress)), url));
    }
    if ((m = /^\/api\/v1\/books\/([^/]+)\/read-progress$/.exec(p))) {
      const id = m[1]!;
      if (method === "PATCH") {
        const u = body as { page?: number; completed?: boolean };
        progress.set(id, { page: u.page ?? 0, completed: u.completed ?? false });
      } else if (method === "DELETE") {
        progress.delete(id);
      }
      return json(204, undefined);
    }
    if ((m = /^\/api\/v1\/books\/([^/]+)\/pages$/.exec(p))) {
      if (opts.noPageStreaming) return json(403, { error: "Forbidden" });
      const b = BOOKS.find((x) => x.id === m![1]);
      if (!b) return json(404, { error: "Not Found" });
      if (b.profile === "EPUB") return json(400, { error: "Bad Request" });
      if (b.status !== "READY") return json(400, { error: "Bad Request" });
      return json(
        200,
        Array.from({ length: b.pages }, (_, i) => ({
          number: i + 1,
          fileName: `${String(i).padStart(3, "0")}.jpg`,
          mediaType: b.pageType ?? "image/jpeg",
          width: 1200,
          height: 1660,
          sizeBytes: 443436,
          size: "433 KiB",
        })),
      );
    }
    if ((m = /^\/api\/v1\/books\/([^/]+)$/.exec(p))) {
      const b = BOOKS.find((x) => x.id === m![1]);
      return b ? json(200, bookDto(b, progress)) : json(404, { error: "Not Found" });
    }
    return json(404, { error: "Not Found" });
  }

  const handle = (req: HttpRequest): HttpResponse => {
    requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== origin) return json(502, { error: `unexpected origin ${url.origin}` });
    const h = req.headers ?? {};
    const open = !opts.authorization && !opts.apiKey;
    const authed =
      open ||
      (opts.authorization !== undefined && h.Authorization === opts.authorization) ||
      (opts.apiKey !== undefined && h["X-API-Key"] === opts.apiKey);
    if (!authed) return json(401, { error: "Unauthorized" });
    return { ...route(req, url), url: req.url };
  };

  return { handle, requests, progress };
}
