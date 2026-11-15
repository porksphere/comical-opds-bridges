import { describe, expect, test } from "bun:test";
import {
  bridgeInfoSchema,
  chapterSchema,
  pageSchema,
  parseLoginRequired,
  seriesEntrySchema,
  seriesInfoSchema,
  seriesListSchema,
  settingsFormSchema,
} from "@comical/contract";
import { mockHost, runConformance } from "@comical/testkit";
import factory, { komgaBase } from "../src/komga.ts";
import { basicAuth } from "../src/core/server.ts";
import {
  BOOK,
  FILLER,
  LIB_COMICS,
  LIB_MANGA,
  SERIES_A,
  SERIES_B,
  SERIES_EPUB,
  type KomgaServerOptions,
  komgaServer,
} from "./fixtures/komga-server.ts";

const ORIGIN = "http://komga.lan:25600";
const AUTH = basicAuth("reader@example.com", "hunter2");
const KEY = "0123456789abcdef0123456789abcdef";
const SIGNED_IN = { serverUrl: ORIGIN, username: "reader@example.com", password: "hunter2" };

function setup(settings: Record<string, string> = SIGNED_IN, server: KomgaServerOptions = { authorization: AUTH }) {
  const komga = komgaServer(ORIGIN, server);
  const host = mockHost({ handle: komga.handle, settings });
  return { komga, host, bridge: factory(host) };
}

const names = async (bridge: ReturnType<typeof factory>) => (await bridge.getLists!()).map((l) => l.name);

describe("server address", () => {
  test.each([
    ["192.168.1.5:25600", "http://192.168.1.5:25600"],
    ["https://komga.example.com/", "https://komga.example.com"],
    ["http://nas:25600/opds/v1.2/catalog", "http://nas:25600"],
    ["http://nas:25600/series/0ABC?x=1#top", "http://nas:25600"],
    ["https://example.com/komga/libraries/0ABC/series", "https://example.com/komga"],
    ["https://example.com/komga/api/v1/series", "https://example.com/komga"],
  ])("%s → %s", (typed, base) => {
    expect(komgaBase(typed)).toBe(base);
  });
});

describe("info", () => {
  test("is valid, and declares no images until a server is set", () => {
    const info = setup({}).bridge.info;
    expect(() => bridgeInfoSchema.parse(info)).not.toThrow();
    expect(info.id).toBe("porksphere.komga");
    expect(info.capabilities).toContain("read-sync");
    expect(info.images).toBeUndefined();
  });

  test("with credentials, images are intercepted and no credential appears in info", async () => {
    for (const settings of [SIGNED_IN, { serverUrl: ORIGIN, apiKey: KEY }]) {
      const { bridge } = setup(settings);
      expect(bridge.info.images).toEqual({ hosts: ["komga.lan"], intercept: ["komga.lan"] });
      expect(bridge.info.linkHosts).toEqual(["komga.lan"]);
      const json = JSON.stringify(bridge.info);
      expect(json).not.toContain("hunter2");
      expect(json).not.toContain(KEY);
    }
  });
});

describe("sign-in", () => {
  test("an API key goes in X-API-Key on every request and image, and wins over a password", async () => {
    const { bridge, komga } = setup({ ...SIGNED_IN, apiKey: KEY }, { apiKey: KEY });
    await bridge.getLists!();
    for (const r of komga.requests) {
      expect(r.headers?.["X-API-Key"]).toBe(KEY);
      expect(r.headers?.Authorization).toBeUndefined();
    }
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/api/v1/books/x/pages/1`)).headers).toEqual({ "X-API-Key": KEY });
  });

  test("an email and password go as Basic auth", async () => {
    const { bridge, komga } = setup();
    await bridge.getLists!();
    for (const r of komga.requests) expect(r.headers?.Authorization).toBe(AUTH);
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/x`)).headers).toEqual({ Authorization: AUTH });
  });

  test("a refused or missing sign-in names the setting to fix", async () => {
    const wrong = await setup({ ...SIGNED_IN, password: "nope" }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((wrong as Error).message)).toEqual({ key: "username", reason: "Komga turned down this sign-in." });
    const badKey = await setup({ serverUrl: ORIGIN, apiKey: "nope" }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((badKey as Error).message)?.key).toBe("apiKey");
    const none = await setup({ serverUrl: ORIGIN }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((none as Error).message)?.key).toBe("apiKey");
  });
});

describe("lists", () => {
  test("recent lists, then libraries and collections; unavailable libraries are left out", async () => {
    const { bridge } = setup();
    const lists = await bridge.getLists!();
    for (const l of lists) expect(() => seriesListSchema.parse(l)).not.toThrow();
    expect(lists.map((l) => l.name)).toEqual(["Recently added", "Manga", "Comics", "Favourites"]);
    expect(lists[0]).toMatchObject({ featured: true, layout: "carousel" });
    expect(lists.find((l) => l.name === "Manga")).toMatchObject({ id: `library:${LIB_MANGA}`, description: "Library" });
  });

  test("Keep reading and On deck appear once they have something", async () => {
    const { bridge, host } = setup();
    expect(await names(bridge)).not.toContain("Keep reading");
    await bridge.markChapterRead!(SERIES_A, BOOK(SERIES_A, 1));
    const fresh = factory(host);
    expect(await names(fresh)).toEqual(["On deck", "Recently added", "Manga", "Comics", "Favourites"]);
    const deck = await fresh.getListItems!("on-deck");
    expect(deck.items).toEqual([
      {
        id: SERIES_A,
        title: "Test Series A",
        subtitle: "Volume 2",
        thumbnailUrl: `${ORIGIN}/api/v1/books/${BOOK(SERIES_A, 2)}/thumbnail`,
      },
    ]);
  });

  test("Keep reading shows each series once, by its latest book", async () => {
    const { bridge, komga } = setup();
    komga.progress.set(BOOK(SERIES_A, 1), { page: 1, completed: false });
    komga.progress.set(BOOK(SERIES_A, 2), { page: 2, completed: false });
    const items = (await bridge.getListItems!("keep-reading")).items;
    expect(items.map((i) => [i.id, i.subtitle])).toEqual([[SERIES_A, "Volume 1"]]);
    const req = komga.requests.find((r) => r.url.includes("/books/list"))!;
    expect(req.url).toContain("sort=readProgress.readDate%2Cdesc");
    expect(JSON.parse(req.body!)).toEqual({ condition: { readStatus: { operator: "is", value: "IN_PROGRESS" } } });
  });

  test("lists are reused for a few minutes", async () => {
    const { bridge, komga } = setup();
    await bridge.getLists!();
    const after = komga.requests.length;
    await bridge.getLists!();
    expect(komga.requests.length).toBe(after);
  });

  test("series cards show their books and unread count", async () => {
    const { bridge, komga } = setup();
    komga.progress.set(BOOK(SERIES_A, 1), { page: 3, completed: true });
    const { items } = await bridge.getListItems!(`library:${LIB_MANGA}`);
    for (const i of items) expect(() => seriesEntrySchema.parse(i)).not.toThrow();
    expect(items[0]).toEqual({
      id: SERIES_A,
      title: "Test Series A",
      thumbnailUrl: `${ORIGIN}/api/v1/series/${SERIES_A}/thumbnail`,
      subtitle: "3 books",
      badges: [{ text: "2", position: "top-right", tone: "info" }],
      readingDirection: "rtl",
      contentRating: "mature",
    });
    // A one-shot is a single book: no count, no badge.
    expect(items[1]).toEqual({ id: SERIES_B, title: "Test Series B", thumbnailUrl: `${ORIGIN}/api/v1/series/${SERIES_B}/thumbnail` });
  });

  test("a library pages with a cursor, sorted by title", async () => {
    const { bridge, komga } = setup();
    const first = await bridge.getListItems!(`library:${LIB_COMICS}`);
    expect(first.items).toHaveLength(24);
    expect(first.nextCursor).toBe("1");
    const second = await bridge.getListItems!(`library:${LIB_COMICS}`, { cursor: first.nextCursor! });
    expect(second.items).toHaveLength(FILLER - 24);
    expect(second.nextCursor).toBeUndefined();
    expect(komga.requests.at(-1)!.url).toContain("sort=metadata.titleSort%2Casc");
  });

  test("a collection keeps its own order", async () => {
    const { bridge } = setup();
    expect((await bridge.getListItems!("collection:COLL1")).items.map((i) => i.id)).toEqual([SERIES_B, SERIES_A]);
  });

  test("an unknown list or cursor is refused", async () => {
    const { bridge } = setup();
    await expect(bridge.getListItems!("nope")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("new", { cursor: "-1" })).rejects.toThrow(/bad cursor/);
  });
});

describe("search", () => {
  test("uses Komga's full-text search", async () => {
    const { bridge, komga } = setup();
    const { items } = await bridge.getSearchResults!({ text: " series a " });
    expect(items.map((i) => i.id)).toEqual([SERIES_A]);
    expect(JSON.parse(komga.requests.at(-1)!.body!)).toEqual({ fullTextSearch: "series a" });
  });

  test("an empty query lists everything by title", async () => {
    const { bridge, komga } = setup();
    expect((await bridge.getSearchResults!({ text: "" })).nextCursor).toBe("1");
    expect(komga.requests.at(-1)!.url).toContain("sort=metadata.titleSort");
  });
});

describe("a series", () => {
  test("details carry Komga's metadata", async () => {
    const { bridge } = setup();
    const info = await bridge.getSeriesDetails(SERIES_A);
    expect(() => seriesInfoSchema.parse(info)).not.toThrow();
    expect(info).toEqual({
      id: SERIES_A,
      title: "Test Series A",
      thumbnailUrl: `${ORIGIN}/api/v1/series/${SERIES_A}/thumbnail`,
      altTitles: ["テスト A"],
      author: "Jane Writer",
      authors: [{ name: "Jane Writer" }],
      artist: "Ann Artist, Cole Ours",
      artists: [{ name: "Ann Artist" }, { name: "Cole Ours" }],
      description: "A series about tests.",
      status: "completed",
      readingDirection: "rtl",
      contentRating: "mature",
      languages: ["ja"],
      tagGroups: [
        { label: "Genres", kind: "genre", tags: ["Action", "Comedy"] },
        { label: "Tags", kind: "other", tags: ["robots", "from-books"] },
      ],
      infoCells: [
        { label: "Publisher", value: "Fixture Press" },
        { label: "Books", value: "3 of 5" },
        { label: "Released", value: "2024" },
      ],
      shareUrl: `${ORIGIN}/series/${SERIES_A}`,
    });
  });

  test("a series without its own summary uses its books'", async () => {
    expect((await setup().bridge.getSeriesDetails(SERIES_B)).description).toBe("The first book's summary.");
  });

  test("chapters are its books in number order, without deleted ones", async () => {
    const { bridge } = setup();
    const chapters = await bridge.getChapters!(SERIES_A);
    for (const c of chapters) expect(() => chapterSchema.parse(c)).not.toThrow();
    expect(chapters).toEqual([
      { id: BOOK(SERIES_A, 1), name: "Volume 1", number: 1, pageCount: 4, publishedAt: Date.parse("2024-05-01") },
      { id: BOOK(SERIES_A, 2), name: "Volume 2", number: 2, pageCount: 3 },
      { id: BOOK(SERIES_A, 3), name: "Volume 3", number: 3 },
    ]);
  });

  test("a series removed from Komga says so", async () => {
    const { bridge } = setup();
    await expect(bridge.getSeriesDetails("0GONE")).rejects.toThrow("[series-gone]");
    await expect(bridge.getChapters!("0GONE")).rejects.toThrow("[series-gone]");
  });
});

describe("pages", () => {
  test("are Komga's page images, one-based on the server, with thumbnails", async () => {
    const { bridge } = setup();
    const pages = await bridge.getChapterPages!(SERIES_A, BOOK(SERIES_A, 1));
    for (const p of pages) expect(() => pageSchema.parse(p)).not.toThrow();
    expect(pages).toHaveLength(4);
    expect(pages[0]).toEqual({
      index: 0,
      imageUrl: `${ORIGIN}/api/v1/books/${BOOK(SERIES_A, 1)}/pages/1`,
      thumbnail: { kind: "image", url: `${ORIGIN}/api/v1/books/${BOOK(SERIES_A, 1)}/pages/1/thumbnail` },
    });
  });

  test("formats some clients can't decode are converted by Komga", async () => {
    const pages = await setup().bridge.getChapterPages!(SERIES_A, BOOK(SERIES_A, 2));
    expect(pages[0]!.imageUrl).toBe(`${ORIGIN}/api/v1/books/${BOOK(SERIES_A, 2)}/pages/1?convert=png`);
  });

  test("a book Komga can't page says why", async () => {
    const { bridge } = setup();
    await expect(bridge.getChapterPages!(SERIES_EPUB, BOOK(SERIES_EPUB, 1))).rejects.toThrow(/text EPUB/);
    await expect(bridge.getChapterPages!(SERIES_A, BOOK(SERIES_A, 3))).rejects.toThrow(/media is error/);
  });

  test("an account without Page streaming is told which role it needs", async () => {
    const { bridge } = setup(SIGNED_IN, { authorization: AUTH, noPageStreaming: true });
    await expect(bridge.getChapterPages!(SERIES_A, BOOK(SERIES_A, 1))).rejects.toThrow(/Page streaming role/);
  });
});

describe("read-sync", () => {
  test("marks books read and unread on Komga, and reads back what is read", async () => {
    const { bridge, komga } = setup();
    expect(await bridge.getReadChapters!(SERIES_A)).toEqual([]);
    await bridge.markChapterRead!(SERIES_A, BOOK(SERIES_A, 2));
    expect(komga.progress.get(BOOK(SERIES_A, 2))).toEqual({ page: 0, completed: true });
    expect(await bridge.getReadChapters!(SERIES_A)).toEqual([BOOK(SERIES_A, 2)]);
    await bridge.markChapterUnread!(SERIES_A, BOOK(SERIES_A, 2));
    expect(await bridge.getReadChapters!(SERIES_A)).toEqual([]);
  });

  test("a book read elsewhere comes back read", async () => {
    const { bridge, komga } = setup();
    komga.progress.set(BOOK(SERIES_A, 1), { page: 3, completed: true });
    komga.progress.set(BOOK(SERIES_A, 2), { page: 1, completed: false });
    expect(await bridge.getReadChapters!(SERIES_A)).toEqual([BOOK(SERIES_A, 1)]);
  });
});

describe("links", () => {
  test("open Komga's series and book pages", async () => {
    const { bridge } = setup();
    expect(await bridge.resolveUrl!(`${ORIGIN}/series/${SERIES_A}`)).toEqual({ seriesId: SERIES_A });
    expect(await bridge.resolveUrl!(`${ORIGIN}/book/${BOOK(SERIES_A, 2)}?page=3`)).toEqual({
      seriesId: SERIES_A,
      chapterId: BOOK(SERIES_A, 2),
    });
    expect(await bridge.resolveUrl!(`${ORIGIN}/libraries/${LIB_MANGA}/series`)).toBeNull();
    expect(await bridge.resolveUrl!(`http://elsewhere/series/${SERIES_A}`)).toBeNull();
  });
});

describe("settings", () => {
  test("the form is valid and warns only for credentials over public http", async () => {
    const footer = async (settings: Record<string, string>) => {
      const form = await setup(settings).bridge.loadSettings!();
      expect(() => settingsFormSchema.parse(form)).not.toThrow();
      return form.sections[1]?.footer;
    };
    expect(await footer(SIGNED_IN)).toMatch(/Page streaming role/);
    expect(await footer({ serverUrl: "http://comics.example.com", apiKey: KEY })).toMatch(/unencrypted/);
    expect(await footer({ serverUrl: "https://comics.example.com", apiKey: KEY })).toMatch(/Page streaming role/);
  });

  test("Test connection says who is signed in, or what is wrong, in plain words", async () => {
    const run = (settings: Record<string, string>, server?: KomgaServerOptions) =>
      setup(settings, server).bridge.runSettingAction!("test");
    expect(await run(SIGNED_IN)).toEqual({ ok: true, message: "Signed in to Komga as reader@example.com." });
    expect(await run({ ...SIGNED_IN, password: "x" })).toEqual({ ok: false, message: "Komga turned down this sign-in." });
    expect(await run({})).toEqual({ ok: false, message: "Enter Komga's address first." });
    expect((await run(SIGNED_IN, { authorization: AUTH, roles: ["USER"] })).message).toMatch(/Page streaming role/);
    expect((await run(SIGNED_IN, { authorization: AUTH, old: true })).message).toMatch(/Komga 1.19 or later/);
  });
});

test("passes the testkit conformance checks", async () => {
  const { bridge } = setup();
  await runConformance(bridge, { searchQuery: "series" });
});
