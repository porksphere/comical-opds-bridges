/**
 * A fake Kavita, served in-process, with the shapes a live Kavita 0.9.1.4 answers with (captured
 * from one), trimmed to the fields that matter. It signs in like Kavita (an API key traded for a
 * bearer token at `/api/Plugin/authenticate`), pages with the `Pagination` header, takes the key as
 * an `apiKey` query parameter on images, and keeps per-chapter progress so read-sync round-trips.
 */
import type { HttpRequest, HttpResponse } from "@comical/sdk";

export const API_KEY = "kavita-test-key-0123456789abcdef";
export const MANGA = 1;
export const EPUB_SERIES = 2;
export const PDF_SERIES = 3;
export const FILLER = 30;
const NONE = -100000;

interface Chapter {
  id: number;
  minNumber: number;
  range: string;
  pages: number;
  isSpecial?: boolean;
  title?: string;
  titleName?: string;
  releaseDate?: string;
}
interface Volume {
  id: number;
  minNumber: number;
  name: string;
  chapters: Chapter[];
}
interface Series {
  id: number;
  name: string;
  libraryId: number;
  format: number;
  localizedName?: string;
  volumes: Volume[];
  loose: Chapter[];
  specials: Chapter[];
}

const SERIES: Series[] = [
  {
    id: MANGA,
    name: "Test Manga",
    localizedName: "テストマンガ",
    libraryId: 1,
    format: 1,
    volumes: [
      { id: 11, minNumber: 1, name: "1", chapters: [{ id: 101, minNumber: NONE, range: "1", pages: 10, title: "Volume 1" }] },
      {
        id: 12,
        minNumber: 2,
        name: "2",
        chapters: [
          { id: 105, minNumber: 5, range: "5", pages: 4, title: "5" },
          { id: 106, minNumber: 6, range: "6", pages: 4, titleName: "The Sixth", releaseDate: "2024-05-01T00:00:00" },
        ],
      },
    ],
    loose: [{ id: 107, minNumber: 7, range: "7", pages: 3, title: "7", releaseDate: "0001-01-01T00:00:00" }],
    specials: [{ id: 190, minNumber: NONE, range: "Omake", pages: 2, isSpecial: true, title: "Omake" }],
  },
  { id: EPUB_SERIES, name: "A Novel", libraryId: 1, format: 3, volumes: [], loose: [{ id: 201, minNumber: 1, range: "1", pages: 1, title: "1" }], specials: [] },
  { id: PDF_SERIES, name: "A PDF", libraryId: 1, format: 4, volumes: [], loose: [{ id: 301, minNumber: 1, range: "1", pages: 3, title: "1" }], specials: [] },
  ...Array.from({ length: FILLER }, (_, i) => ({
    id: 1000 + i,
    name: `Filler ${String(i).padStart(2, "0")}`,
    libraryId: 2,
    format: 1,
    volumes: [],
    loose: [{ id: 10000 + i, minNumber: 1, range: "1", pages: 1, title: "1" }],
    specials: [],
  })),
];

const chaptersOf = (s: Series): Chapter[] => [...s.volumes.flatMap((v) => v.chapters), ...s.loose, ...s.specials];

export interface KavitaServerOptions {
  /** Every token issued expires after this many API calls (to exercise signing in again). */
  tokenLifetime?: number;
}

export function kavitaServer(origin = "http://kavita.lan:5000", opts: KavitaServerOptions = {}) {
  const requests: HttpRequest[] = [];
  const progress = new Map<number, number>(); // chapter id → pages read
  let tokenSeq = 0;
  const tokens = new Map<string, number>(); // token → calls left

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
    url: "",
    status,
    statusText: String(status),
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
  });

  function seriesDto(s: Series) {
    const chapters = chaptersOf(s);
    return {
      id: s.id,
      name: s.name,
      originalName: s.name,
      localizedName: s.localizedName ?? "",
      sortName: s.name,
      pages: chapters.reduce((n, c) => n + c.pages, 0),
      pagesRead: chapters.reduce((n, c) => n + (progress.get(c.id) ?? 0), 0),
      format: s.format,
      libraryId: s.libraryId,
      libraryName: s.libraryId === 1 ? "Manga" : "Comics",
    };
  }
  function chapterDto(c: Chapter, volumeId: number) {
    return {
      id: c.id,
      range: c.range,
      number: c.minNumber === NONE ? String(NONE) : String(c.minNumber),
      minNumber: c.minNumber,
      maxNumber: c.minNumber,
      sortOrder: c.minNumber,
      pages: c.pages,
      pagesRead: progress.get(c.id) ?? 0,
      isSpecial: c.isSpecial ?? false,
      title: c.title ?? "",
      titleName: c.titleName ?? "",
      releaseDate: c.releaseDate ?? "0001-01-01T00:00:00",
      volumeId,
    };
  }
  function paged<T>(all: T[], url: URL): HttpResponse {
    const page = Number(url.searchParams.get("PageNumber") ?? 1);
    const size = Number(url.searchParams.get("PageSize") ?? 20);
    const totalPages = Math.max(1, Math.ceil(all.length / size));
    return reply(200, all.slice((page - 1) * size, page * size), {
      pagination: JSON.stringify({ currentPage: page, itemsPerPage: size, totalItems: all.length, totalPages }),
    });
  }

  function route(req: HttpRequest, url: URL): HttpResponse {
    const p = url.pathname;
    const method = req.method ?? "GET";
    const q = (k: string) => url.searchParams.get(k);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const find = (id: string | null) => SERIES.find((s) => String(s.id) === id);

    if (p === "/api/Library/libraries") {
      return reply(200, [
        { id: 1, name: "Manga", type: 0, folders: ["/manga"] },
        { id: 2, name: "Comics", type: 1, folders: ["/comics"] },
      ]);
    }
    if (p === "/api/Collection") return reply(200, [{ id: 7, title: "Favourites", itemCount: 2 }]);
    if (p === "/api/Series/series-by-collection" && q("collectionId") === "7") {
      return paged([find(String(PDF_SERIES))!, find(String(MANGA))!].map(seriesDto), url);
    }
    if (p === "/api/Series/on-deck" && method === "POST") {
      const started = SERIES.filter((s) => {
        const read = chaptersOf(s).map((c) => progress.get(c.id) ?? 0);
        return read.some((n) => n > 0) && chaptersOf(s).some((c) => (progress.get(c.id) ?? 0) < c.pages);
      });
      return paged(started.map(seriesDto), url);
    }
    if (p === "/api/Series/recently-added-v2" && method === "POST") return paged(SERIES.slice(0, 3).map(seriesDto), url);
    if (p === "/api/Series/all-v2" && method === "POST") {
      const statements = (body.statements as Array<{ field: number; comparison: number; value: string }>) ?? [];
      const lib = statements.find((s) => s.field === 19 && s.comparison === 0)?.value;
      return paged(SERIES.filter((s) => !lib || String(s.libraryId) === lib).map(seriesDto), url);
    }
    if (p === "/api/Search/search") {
      const text = (q("queryString") ?? "").toLowerCase();
      const series = SERIES.filter((s) => s.name.toLowerCase().includes(text)).map((s) => ({
        seriesId: s.id,
        name: s.name,
        format: s.format,
        libraryId: s.libraryId,
      }));
      return reply(200, { libraries: [], series, collections: [], readingLists: [], persons: [], genres: [], tags: [], files: [], chapters: [] });
    }
    if (p === "/api/Series/metadata") {
      const s = find(q("seriesId"));
      if (!s) return reply(204, undefined);
      return reply(
        200,
        s.id === MANGA
          ? {
              seriesId: s.id,
              summary: "A manga about tests.",
              genres: [{ id: 1, title: "Action" }],
              tags: [{ id: 1, title: "robots" }],
              writers: [{ id: 1, name: "Jane Writer" }],
              pencillers: [{ id: 2, name: "Ann Artist" }],
              inkers: [{ id: 2, name: "Ann Artist" }],
              colorists: [],
              coverArtists: [{ id: 3, name: "Cole Ours" }],
              publishers: [{ id: 4, name: "Fixture Press" }],
              ageRating: 8,
              releaseYear: 2024,
              language: "ja",
              publicationStatus: 4,
            }
          : { seriesId: s.id, summary: "", genres: [], tags: [], writers: [], ageRating: 0, releaseYear: 0, language: "", publicationStatus: 0 },
      );
    }
    if (p === "/api/Series/series-detail") {
      const s = find(q("seriesId"));
      if (!s) return reply(400, "Series does not exist", { "content-type": "text/plain" });
      return reply(200, {
        specials: s.specials.map((c) => chapterDto(c, 99)),
        // Like Kavita: the loose-leaf volume isn't listed; its chapters are.
        volumes: s.volumes.map((v) => ({ id: v.id, minNumber: v.minNumber, name: v.name, number: v.minNumber, chapters: v.chapters.map((c) => chapterDto(c, v.id)) })),
        chapters: s.loose.map((c) => chapterDto(c, 98)),
        storylineChapters: s.loose.map((c) => chapterDto(c, 98)),
        libraryType: 0,
        unreadCount: 0,
        totalCount: chaptersOf(s).length,
      });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/Series\/(\d+)$/.exec(p))) {
      const s = find(m[1]!);
      return s ? reply(200, seriesDto(s)) : reply(404, { title: "Not Found", status: 404 });
    }
    if (p === "/api/Reader/chapter-info") {
      const s = SERIES.find((x) => chaptersOf(x).some((c) => String(c.id) === q("chapterId")));
      const c = s && chaptersOf(s).find((x) => String(x.id) === q("chapterId"));
      if (!s || !c) return reply(404, { title: "Not Found", status: 404 });
      return reply(200, { pages: c.pages, seriesFormat: s.format, seriesId: s.id, seriesName: s.name, isSpecial: c.isSpecial ?? false });
    }
    if ((p === "/api/Reader/mark-multiple-read" || p === "/api/Reader/mark-multiple-unread") && method === "POST") {
      const read = p.endsWith("-read");
      for (const id of (body.chapterIds as number[]) ?? []) {
        const c = SERIES.flatMap(chaptersOf).find((x) => x.id === id);
        if (!c) return reply(400, "Chapter does not exist", { "content-type": "text/plain" });
        if (read) progress.set(id, c.pages);
        else progress.delete(id);
      }
      return reply(200, undefined);
    }
    return reply(404, { title: "Not Found", status: 404 });
  }

  const handle = (req: HttpRequest): HttpResponse => {
    requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== origin) return reply(502, { error: `unexpected origin ${url.origin}` });

    if (url.pathname === "/api/Plugin/authenticate" && req.method === "POST") {
      if (url.searchParams.get("apiKey") !== API_KEY) return reply(401, { status: 401, message: "Unauthorized" });
      const token = `token-${++tokenSeq}`;
      tokens.set(token, opts.tokenLifetime ?? Number.POSITIVE_INFINITY);
      return { ...reply(200, { username: "reader", token, refreshToken: "r" }), url: req.url };
    }
    // Images and the version take the key as a query parameter.
    if (url.pathname.startsWith("/api/Image/") || url.pathname === "/api/Reader/image" || url.pathname === "/api/Plugin/version") {
      if (url.searchParams.get("apiKey") !== API_KEY) return reply(401, undefined);
      if (url.pathname === "/api/Plugin/version") return { ...reply(200, '"0.9.1.4"'), url: req.url };
      return { url: req.url, status: 200, statusText: "OK", headers: { "content-type": "image/jpeg" }, body: "jpeg" };
    }
    const token = req.headers?.Authorization?.replace(/^Bearer /, "");
    const left = token ? tokens.get(token) : undefined;
    if (left === undefined || left <= 0) return reply(401, undefined);
    tokens.set(token!, left - 1);
    return { ...route(req, url), url: req.url };
  };

  return { handle, requests, progress };
}
