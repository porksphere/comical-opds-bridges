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
import factory, { kavitaBase } from "../src/kavita.ts";
import { API_KEY, EPUB_SERIES, FILLER, MANGA, PDF_SERIES, type KavitaServerOptions, kavitaServer } from "./fixtures/kavita-server.ts";

const ORIGIN = "http://kavita.lan:5000";
const SIGNED_IN = { serverUrl: ORIGIN, apiKey: API_KEY };

function setup(settings: Record<string, string> = SIGNED_IN, server: KavitaServerOptions = {}) {
  const kavita = kavitaServer(ORIGIN, server);
  const host = mockHost({ handle: kavita.handle, settings });
  return { kavita, host, bridge: factory(host) };
}

describe("server address", () => {
  test.each([
    ["192.168.1.5:5000", { base: "http://192.168.1.5:5000" }],
    ["http://nas:5000/library/1/series/2", { base: "http://nas:5000" }],
    ["https://example.com/kavita/home", { base: "https://example.com/kavita" }],
    ["http://nas:5000/api/opds/abc123", { base: "http://nas:5000", apiKey: "abc123" }],
    ["https://example.com/kavita/api/opds/abc123/series/4", { base: "https://example.com/kavita", apiKey: "abc123" }],
  ])("%s", (typed, expected) => {
    expect(kavitaBase(typed)).toEqual(expected);
  });
});

describe("info", () => {
  test("is valid, and the API key appears nowhere in it", () => {
    for (const settings of [SIGNED_IN, { serverUrl: `${ORIGIN}/api/opds/${API_KEY}` }]) {
      const info = setup(settings).bridge.info;
      expect(() => bridgeInfoSchema.parse(info)).not.toThrow();
      expect(info.images).toEqual({ hosts: ["kavita.lan"], intercept: ["kavita.lan"] });
      expect(JSON.stringify(info)).not.toContain(API_KEY);
    }
    expect(setup({}).bridge.info.images).toBeUndefined();
  });
});

describe("sign-in", () => {
  test("the API key is traded for a token once, and the token signs every call", async () => {
    const { bridge, kavita } = setup();
    await bridge.getLists!();
    await bridge.getChapters!(String(MANGA));
    const auths = kavita.requests.filter((r) => r.url.includes("/api/Plugin/authenticate"));
    expect(auths).toHaveLength(1);
    for (const r of kavita.requests.filter((x) => !x.url.includes("/api/Plugin/"))) {
      expect(r.headers?.Authorization).toBe("Bearer token-1");
      expect(r.url).not.toContain(API_KEY);
    }
  });

  test("an expired token is renewed once, without the caller noticing", async () => {
    const { bridge, kavita } = setup(SIGNED_IN, { tokenLifetime: 2 });
    await bridge.getChapters!(String(MANGA));
    await bridge.getChapters!(String(MANGA));
    await bridge.getChapters!(String(MANGA));
    expect(kavita.requests.filter((r) => r.url.includes("/api/Plugin/authenticate")).length).toBe(2);
  });

  test("the OPDS URL alone signs in", async () => {
    const { bridge } = setup({ serverUrl: `${ORIGIN}/api/opds/${API_KEY}` });
    expect((await bridge.getLists!()).length).toBeGreaterThan(0);
  });

  test("a refused or missing key names the setting to fix", async () => {
    const wrong = await setup({ serverUrl: ORIGIN, apiKey: "nope" }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((wrong as Error).message)).toEqual({ key: "apiKey", reason: "Kavita turned down this API key." });
    const none = await setup({ serverUrl: ORIGIN }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((none as Error).message)?.key).toBe("apiKey");
  });

  test("images get the key as Kavita wants it, at fetch time", async () => {
    const { bridge } = setup();
    expect(await bridge.interceptImageRequest!(`${ORIGIN}/api/Reader/image?chapterId=1&page=0`)).toEqual({
      url: `${ORIGIN}/api/Reader/image?chapterId=1&page=0&apiKey=${API_KEY}`,
    });
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/api/Image/x`)).url).toBe(`${ORIGIN}/api/Image/x?apiKey=${API_KEY}`);
  });
});

describe("lists", () => {
  test("Recently added, then libraries and collections; On deck once something is started", async () => {
    const { bridge, host } = setup();
    const lists = await bridge.getLists!();
    for (const l of lists) expect(() => seriesListSchema.parse(l)).not.toThrow();
    expect(lists.map((l) => l.name)).toEqual(["Recently added", "Manga", "Comics", "Favourites"]);
    await bridge.markChapterRead!(String(MANGA), "101");
    expect((await factory(host).getLists!()).map((l) => l.name)).toEqual(["On deck", "Recently added", "Manga", "Comics", "Favourites"]);
  });

  test("a library pages with Kavita's Pagination header", async () => {
    const { bridge } = setup();
    const first = await bridge.getListItems!("library:2");
    for (const i of first.items) expect(() => seriesEntrySchema.parse(i)).not.toThrow();
    expect(first.items).toHaveLength(24);
    expect(first.items[0]).toEqual({ id: "1000", title: "Filler 00", thumbnailUrl: `${ORIGIN}/api/Image/series-cover?seriesId=1000` });
    expect(first.nextCursor).toBe("2");
    const second = await bridge.getListItems!("library:2", { cursor: "2" });
    expect(second.items).toHaveLength(FILLER - 24);
    expect(second.nextCursor).toBeUndefined();
  });

  test("a collection keeps its order", async () => {
    expect((await setup().bridge.getListItems!("collection:7")).items.map((i) => i.id)).toEqual([String(PDF_SERIES), String(MANGA)]);
  });

  test("an unknown list or cursor is refused", async () => {
    const { bridge } = setup();
    await expect(bridge.getListItems!("library:../x")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("recently-added", { cursor: "0" })).rejects.toThrow(/bad cursor/);
  });
});

describe("search", () => {
  test("uses Kavita's search", async () => {
    const { bridge, kavita } = setup();
    expect((await bridge.getSearchResults!({ text: "manga" })).items).toEqual([
      { id: String(MANGA), title: "Test Manga", thumbnailUrl: `${ORIGIN}/api/Image/series-cover?seriesId=${MANGA}` },
    ]);
    expect(kavita.requests.at(-1)!.url).toContain("queryString=manga");
  });

  test("an empty query lists everything, paged", async () => {
    expect((await setup().bridge.getSearchResults!({ text: " " })).nextCursor).toBe("2");
  });
});

describe("a series", () => {
  test("details carry Kavita's metadata", async () => {
    const info = await setup().bridge.getSeriesDetails(String(MANGA));
    expect(() => seriesInfoSchema.parse(info)).not.toThrow();
    expect(info).toEqual({
      id: String(MANGA),
      title: "Test Manga",
      thumbnailUrl: `${ORIGIN}/api/Image/series-cover?seriesId=${MANGA}`,
      altTitles: ["テストマンガ"],
      author: "Jane Writer",
      authors: [{ name: "Jane Writer" }],
      artist: "Ann Artist, Cole Ours",
      artists: [{ name: "Ann Artist" }, { name: "Cole Ours" }],
      description: "A manga about tests.",
      status: "completed",
      contentRating: "everyone",
      languages: ["ja"],
      tagGroups: [
        { label: "Genres", kind: "genre", tags: ["Action"] },
        { label: "Tags", kind: "other", tags: ["robots"] },
      ],
      infoCells: [
        { label: "Publisher", value: "Fixture Press" },
        { label: "Released", value: "2024" },
        { label: "Pages", value: "23" },
      ],
      shareUrl: `${ORIGIN}/library/1/series/${MANGA}`,
    });
  });

  test("chapters: volumes' chapters, loose chapters, then specials", async () => {
    const chapters = await setup().bridge.getChapters!(String(MANGA));
    for (const c of chapters) expect(() => chapterSchema.parse(c)).not.toThrow();
    expect(chapters).toEqual([
      { id: "101", name: "Volume 1", volume: 1, pageCount: 10 },
      { id: "105", name: "5", number: 5, volume: 2, pageCount: 4 },
      { id: "106", name: "The Sixth", number: 6, volume: 2, pageCount: 4, publishedAt: Date.parse("2024-05-01T00:00:00") },
      { id: "107", name: "7", number: 7, pageCount: 3 },
      { id: "190", name: "Omake", pageCount: 2 },
    ]);
  });

  test("a series removed from Kavita says so", async () => {
    const { bridge } = setup();
    await expect(bridge.getSeriesDetails("9999")).rejects.toThrow("[series-gone]");
    await expect(bridge.getChapters!("9999")).rejects.toThrow("[series-gone]");
    await expect(bridge.getChapters!("../1")).rejects.toThrow(/not a Kavita id/);
  });
});

describe("pages", () => {
  test("are Kavita's page images, zero-based, without the key", async () => {
    const pages = await setup().bridge.getChapterPages!(String(MANGA), "105");
    for (const p of pages) expect(() => pageSchema.parse(p)).not.toThrow();
    expect(pages.map((p) => p.imageUrl)).toEqual([0, 1, 2, 3].map((i) => `${ORIGIN}/api/Reader/image?chapterId=105&page=${i}`));
  });

  test("a PDF's pages are extracted; a text EPUB says why it can't open", async () => {
    const { bridge } = setup();
    expect((await bridge.getChapterPages!(String(PDF_SERIES), "301"))[0]!.imageUrl).toContain("&extractPdf=true");
    await expect(bridge.getChapterPages!(String(EPUB_SERIES), "201")).rejects.toThrow(/text EPUB/);
  });
});

describe("read-sync", () => {
  test("marks chapters read and unread on Kavita, and reads back what is read", async () => {
    const { bridge, kavita } = setup();
    expect(await bridge.getReadChapters!(String(MANGA))).toEqual([]);
    await bridge.markChapterRead!(String(MANGA), "106");
    expect(kavita.progress.get(106)).toBe(4);
    expect(await bridge.getReadChapters!(String(MANGA))).toEqual(["106"]);
    await bridge.markChapterUnread!(String(MANGA), "106");
    expect(await bridge.getReadChapters!(String(MANGA))).toEqual([]);
  });

  test("a chapter only partly read elsewhere isn't read", async () => {
    const { bridge, kavita } = setup();
    kavita.progress.set(101, 10);
    kavita.progress.set(105, 2);
    expect(await bridge.getReadChapters!(String(MANGA))).toEqual(["101"]);
  });
});

describe("links", () => {
  test("open Kavita's series and reader pages", async () => {
    const { bridge } = setup();
    expect(await bridge.resolveUrl!(`${ORIGIN}/library/1/series/1`)).toEqual({ seriesId: "1" });
    expect(await bridge.resolveUrl!(`${ORIGIN}/library/1/series/1/manga/105?incognitoMode=false`)).toEqual({ seriesId: "1", chapterId: "105" });
    expect(await bridge.resolveUrl!(`${ORIGIN}/home`)).toBeNull();
    expect(await bridge.resolveUrl!("http://elsewhere/library/1/series/1")).toBeNull();
  });
});

describe("settings", () => {
  test("the form is valid and warns only for a key over public http", async () => {
    const footer = async (settings: Record<string, string>) => {
      const form = await setup(settings).bridge.loadSettings!();
      expect(() => settingsFormSchema.parse(form)).not.toThrow();
      return form.sections[1]?.footer;
    };
    expect(await footer(SIGNED_IN)).toBeUndefined();
    expect(await footer({ serverUrl: "http://comics.example.com", apiKey: API_KEY })).toMatch(/your API key is sent unencrypted/);
    expect(await footer({ serverUrl: "https://comics.example.com", apiKey: API_KEY })).toBeUndefined();
  });

  test("Test connection says who is signed in to which Kavita, or what is wrong", async () => {
    expect(await setup().bridge.runSettingAction!("test")).toEqual({ ok: true, message: "Signed in to Kavita 0.9.1.4 as reader." });
    expect(await setup({ serverUrl: ORIGIN, apiKey: "x" }).bridge.runSettingAction!("test")).toEqual({
      ok: false,
      message: "Kavita turned down this API key.",
    });
    expect(await setup({}).bridge.runSettingAction!("test")).toEqual({ ok: false, message: "Enter Kavita's address first." });
  });
});

test("passes the testkit conformance checks", async () => {
  await runConformance(setup().bridge, { searchQuery: "manga" });
});
