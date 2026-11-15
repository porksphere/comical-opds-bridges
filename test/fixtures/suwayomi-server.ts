/**
 * A fake Suwayomi-Server, served in-process. It answers the GraphQL operations the bridge sends
 * (recognised by their root field), with the shapes a live Suwayomi v2.4 answers with (captured
 * from one), and keeps library membership and read state. Auth follows Suwayomi's modes: none,
 * Basic auth, or UI login (the `login` mutation's bearer token).
 */
import type { HttpRequest, HttpResponse } from "@comical/sdk";

export const USER = "reader";
export const PASS = "hunter2";
export const LOCAL = "0";
export const ONLINE = "2499283573021220255";
export const NSFW_SOURCE = "6400665728063187402";

interface Manga {
  id: number;
  title: string;
  source: string;
  thumbnailUrl: string | null;
  author?: string;
  artist?: string;
  description?: string;
  genre?: string[];
  status?: string;
  realUrl?: string;
  inLibrary?: boolean;
  categoryId?: number;
  initialized?: boolean;
}
interface Chapter {
  id: number;
  mangaId: number;
  name: string;
  chapterNumber: number;
  sourceOrder: number;
  scanlator?: string;
  uploadDate: string;
  pages: number;
  fetchedAt: number;
}

const SOURCES = [
  { id: ONLINE, displayName: "MangaDex (EN)", name: "MangaDex", lang: "en", contentWarning: "SAFE" },
  { id: LOCAL, displayName: "Local source", name: "Local source", lang: "localsourcelang", contentWarning: "SAFE" },
  { id: NSFW_SOURCE, displayName: "Spicy (EN)", name: "Spicy", lang: "en", contentWarning: "NSFW" },
];

export type AuthMode = "NONE" | "BASIC_AUTH" | "UI_LOGIN";

export function suwayomiServer(origin = "http://suwayomi.lan:4567", opts: { auth?: AuthMode; failSources?: string[] } = {}) {
  const auth = opts.auth ?? "NONE";
  const requests: HttpRequest[] = [];
  const read = new Set<number>();
  let tokenSeq = 0;
  const tokens = new Set<string>();

  const mangas: Manga[] = [
    {
      id: 1,
      title: "Pepper&Carrot",
      source: LOCAL,
      thumbnailUrl: null,
      inLibrary: false,
      initialized: false,
    },
    {
      id: 5,
      title: "Online Series",
      source: ONLINE,
      thumbnailUrl: "/api/v1/manga/5/thumbnail",
      author: "Jane Writer, Ann Artist",
      artist: "Ann Artist",
      description: "  An online series.  ",
      genre: ["Action", " Comedy", "Action"],
      status: "PUBLISHING_FINISHED",
      realUrl: "https://mangadex.org/title/abc",
      inLibrary: true,
      categoryId: 2,
      initialized: true,
    },
    { id: 6, title: "Uncategorized Series", source: ONLINE, thumbnailUrl: "/api/v1/manga/6/thumbnail", inLibrary: true, initialized: true },
    { id: 7, title: "Spicy Series", source: NSFW_SOURCE, thumbnailUrl: "/api/v1/manga/7/thumbnail", initialized: true },
    ...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, title: `Popular ${String(i).padStart(2, "0")}`, source: ONLINE, thumbnailUrl: `/api/v1/manga/${100 + i}/thumbnail`, initialized: true })),
  ];
  const chapters: Chapter[] = [
    { id: 1, mangaId: 1, name: "01 - Potion of Flight", chapterNumber: 1, sourceOrder: 1, uploadDate: "1794712576879", pages: 5, fetchedAt: 1 },
    { id: 2, mangaId: 1, name: "02 - Rainbow potions", chapterNumber: 2, sourceOrder: 2, uploadDate: "1794712577125", pages: 7, fetchedAt: 1 },
    { id: 52, mangaId: 5, name: "Ch. 2", chapterNumber: 2, sourceOrder: 2, scanlator: "Team A", uploadDate: "0", pages: 4, fetchedAt: 30 },
    { id: 51, mangaId: 5, name: "Ch. 1", chapterNumber: 1, sourceOrder: 1, uploadDate: "1700000000000", pages: 4, fetchedAt: 10 },
    { id: 50, mangaId: 5, name: "Extra", chapterNumber: -1, sourceOrder: 0, uploadDate: "0", pages: 2, fetchedAt: 10 },
    { id: 61, mangaId: 6, name: "Ch. 1", chapterNumber: 1, sourceOrder: 1, uploadDate: "0", pages: 1, fetchedAt: 20 },
  ];

  const source = (id: string) => SOURCES.find((s) => s.id === id)!;
  const mangaDto = (m: Manga) => ({
    id: m.id,
    title: m.title,
    thumbnailUrl: m.thumbnailUrl,
    author: m.author ?? null,
    artist: m.artist ?? null,
    description: m.description ?? null,
    genre: m.genre ?? [],
    status: m.status ?? "UNKNOWN",
    realUrl: m.realUrl ?? null,
    initialized: m.initialized ?? false,
    inLibrary: m.inLibrary ?? false,
    unreadCount: chapters.filter((c) => c.mangaId === m.id && !read.has(c.id)).length,
    source: source(m.source),
  });
  const chapterDto = (c: Chapter) => ({
    id: c.id,
    name: c.name,
    chapterNumber: c.chapterNumber,
    scanlator: c.scanlator ?? null,
    uploadDate: c.uploadDate,
    pageCount: -1,
    isRead: read.has(c.id),
    lastPageRead: 0,
    sourceOrder: c.sourceOrder,
    mangaId: c.mangaId,
    manga: mangaDto(mangas.find((m) => m.id === c.mangaId)!),
  });
  const ok = (data: unknown) => ({ data });
  const fail = (message: string, path: string) => ({ data: null, errors: [{ message, path: [path] }] });

  function execute(query: string, v: Record<string, any>): unknown {
    const has = (field: string) => new RegExp(`\\b${field}\\s*\\(|\\b${field}\\s*\\{`).test(query);
    if (has("login")) {
      if (auth !== "UI_LOGIN") return fail("Unsupported auth mode", "login");
      if (v.u !== USER || v.p !== PASS) return fail("Invalid username or password", "login");
      const token = `jwt-${++tokenSeq}`;
      tokens.add(token);
      return ok({ login: { accessToken: token, refreshToken: "r" } });
    }
    if (has("aboutServer")) return ok({ aboutServer: { name: "Suwayomi-Server", version: "v2.4.2366" } });
    if (has("sources")) return ok({ sources: { nodes: SOURCES.map(({ id, displayName, lang, contentWarning }) => ({ id, displayName, lang, contentWarning })) } });
    if (has("categories")) {
      return ok({ categories: { nodes: [{ id: 0, name: "Default", default: true, order: 0 }, { id: 2, name: "Reading", default: false, order: 1 }] } });
    }
    if (has("fetchSourceManga")) {
      const { source: src, type, page, query: text } = v.input as { source: string; type: string; page: number; query?: string };
      if (opts.failSources?.includes(src)) return fail("HTTP error 503", "fetchSourceManga");
      let found = mangas.filter((m) => m.source === src);
      if (type === "SEARCH") found = found.filter((m) => m.title.toLowerCase().includes(String(text).toLowerCase()));
      const slice = found.slice((page - 1) * 20, page * 20);
      return ok({ fetchSourceManga: { hasNextPage: found.length > page * 20, mangas: slice.map(mangaDto) } });
    }
    if (has("fetchMangaAndChapters")) {
      const m = mangas.find((x) => x.id === v.id);
      if (!m) return fail("Exception while fetching data (/fetchMangaAndChapters) : Collection is empty.", "fetchMangaAndChapters");
      if (opts.failSources?.includes(m.source)) return fail("HTTP error 503", "fetchMangaAndChapters");
      m.initialized = true;
      return ok({ fetchMangaAndChapters: { manga: mangaDto(m), chapters: chapters.filter((c) => c.mangaId === m.id).map(chapterDto) } });
    }
    if (has("fetchChapterPages")) {
      const c = chapters.find((x) => x.id === v.id)!;
      return ok({ fetchChapterPages: { pages: Array.from({ length: c.pages }, (_, i) => `/api/v1/manga/${c.mangaId}/chapter/${c.sourceOrder}/page/${i}`) } });
    }
    if (has("updateChapter")) {
      if (v.read) read.add(v.id);
      else read.delete(v.id);
      return ok({ updateChapter: { chapter: { id: v.id } } });
    }
    // Root fields first: a nested `manga { … }` (in a chapters query) is not a manga lookup.
    if (has("mangas")) {
      const f = (v.filter ?? {}) as { categoryId?: { equalTo?: number; isNull?: boolean } };
      const title = v.title as string | undefined;
      let found = mangas.filter((m) => m.inLibrary).sort((a, b) => a.title.localeCompare(b.title));
      if (f.categoryId?.equalTo !== undefined) found = found.filter((m) => m.categoryId === f.categoryId!.equalTo);
      if (f.categoryId?.isNull) found = found.filter((m) => m.categoryId === undefined);
      if (title) found = found.filter((m) => m.title.toLowerCase().includes(title.toLowerCase()));
      const first = v.first ?? 50;
      const offset = v.offset ?? 0;
      return ok({ mangas: { nodes: found.slice(offset, offset + first).map(mangaDto), pageInfo: { hasNextPage: found.length > offset + first } } });
    }
    if (has("chapters")) {
      if (query.includes("inLibrary")) {
        const recent = chapters
          .filter((c) => mangas.find((m) => m.id === c.mangaId)?.inLibrary)
          .sort((a, b) => b.fetchedAt - a.fetchedAt)
          .slice(0, v.first ?? 50);
        return ok({ chapters: { nodes: recent.map(chapterDto) } });
      }
      let found = chapters.filter((c) => c.mangaId === (v.id ?? v.manga));
      if (query.includes("isRead: true")) found = found.filter((c) => read.has(c.id));
      if (v.order !== undefined) found = found.filter((c) => c.sourceOrder === v.order);
      return ok({ chapters: { nodes: found.map(chapterDto) } });
    }
    if (has("manga")) {
      const m = mangas.find((x) => x.id === v.id);
      if (!m) return fail("The field at path '/manga' was declared as a non null type, but the code involved in retrieving data has wrongly returned a null value.", "manga");
      return ok({ manga: mangaDto(m) });
    }
    return { errors: [{ message: `fixture doesn't understand: ${query.slice(0, 80)}` }] };
  }

  const handle = (req: HttpRequest): HttpResponse => {
    requests.push(req);
    const url = new URL(req.url);
    const json = (status: number, body: unknown): HttpResponse => ({
      url: req.url,
      status,
      statusText: String(status),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (url.origin !== origin) return json(502, { error: "wrong origin" });
    if (url.pathname !== "/api/graphql") return json(404, {});
    const body = JSON.parse(req.body ?? "{}") as { query: string; variables?: Record<string, unknown> };
    const header = req.headers?.Authorization;
    if (auth === "BASIC_AUTH" && header !== `Basic ${btoa(`${USER}:${PASS}`)}`) return json(401, {});
    // UI login: only the login mutation is open; everything else needs a token it gave out.
    if (auth === "UI_LOGIN" && !/\blogin\s*\(/.test(body.query) && !tokens.has(header?.replace(/^Bearer /, "") ?? "")) {
      return json(401, {});
    }
    return json(200, execute(body.query, body.variables ?? {}));
  };

  /** Forget every UI-login token, as when they expire. */
  const expireTokens = () => tokens.clear();
  return { handle, requests, read, mangas, expireTokens };
}
