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
import factory, { suwayomiBase } from "../src/suwayomi.ts";
import { basicAuth } from "../src/core/server.ts";
import { type AuthMode, LOCAL, NSFW_SOURCE, ONLINE, PASS, USER, suwayomiServer } from "./fixtures/suwayomi-server.ts";

const ORIGIN = "http://suwayomi.lan:4567";
const OPEN = { serverUrl: ORIGIN };
const SIGNED_IN = { serverUrl: ORIGIN, username: USER, password: PASS };

function setup(settings: Record<string, string> = OPEN, server: { auth?: AuthMode; failSources?: string[] } = {}) {
  const suwayomi = suwayomiServer(ORIGIN, server);
  const host = mockHost({ handle: suwayomi.handle, settings });
  return { suwayomi, host, bridge: factory(host) };
}

describe("server address", () => {
  test.each([
    ["192.168.1.5:4567", "http://192.168.1.5:4567"],
    ["http://nas:4567/manga/5/chapter/2", "http://nas:4567"],
    ["https://example.com/suwayomi/library", "https://example.com/suwayomi"],
    ["http://nas:4567/api/graphql", "http://nas:4567"],
  ])("%s → %s", (typed, base) => {
    expect(suwayomiBase(typed)).toBe(base);
  });
});

describe("info", () => {
  test("is valid; images are intercepted only with a sign-in, which never appears in info", () => {
    const open = setup().bridge.info;
    expect(() => bridgeInfoSchema.parse(open)).not.toThrow();
    expect(open.images).toEqual({ hosts: ["suwayomi.lan"] });
    const signed = setup(SIGNED_IN).bridge.info;
    expect(signed.images).toEqual({ hosts: ["suwayomi.lan"], intercept: ["suwayomi.lan"] });
    expect(JSON.stringify(signed)).not.toContain(PASS);
  });
});

describe("sign-in", () => {
  test("no sign-in sends no credentials", async () => {
    const { bridge, suwayomi } = setup();
    await bridge.getLists!();
    for (const r of suwayomi.requests) expect(r.headers?.Authorization).toBeUndefined();
  });

  test("Basic auth goes on every call and image", async () => {
    const { bridge, suwayomi } = setup(SIGNED_IN, { auth: "BASIC_AUTH" });
    await bridge.getLists!();
    for (const r of suwayomi.requests) expect(r.headers?.Authorization).toBe(basicAuth(USER, PASS));
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/api/v1/manga/5/thumbnail`)).headers).toEqual({
      Authorization: basicAuth(USER, PASS),
    });
  });

  test("UI login: Basic is turned down, so the bridge logs in and uses the token, also for images", async () => {
    const { bridge, suwayomi } = setup(SIGNED_IN, { auth: "UI_LOGIN" });
    expect((await bridge.getLists!()).length).toBeGreaterThan(0);
    expect(suwayomi.requests.filter((r) => r.body?.includes("login(")).length).toBe(1);
    expect(suwayomi.requests.at(-1)!.headers?.Authorization).toBe("Bearer jwt-1");
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/x`)).headers).toEqual({ Authorization: "Bearer jwt-1" });
  });

  test("an expired UI-login token is renewed", async () => {
    const { bridge, suwayomi } = setup(SIGNED_IN, { auth: "UI_LOGIN" });
    await bridge.getChapters!("5");
    suwayomi.expireTokens();
    expect(await bridge.getChapters!("5")).toHaveLength(3);
    expect(suwayomi.requests.at(-1)!.headers?.Authorization).toBe("Bearer jwt-2");
  });

  test("a refused or missing sign-in names the setting to fix", async () => {
    for (const auth of ["BASIC_AUTH", "UI_LOGIN"] as const) {
      const wrong = await setup({ ...SIGNED_IN, password: "x" }, { auth }).bridge.getLists!().catch((e: Error) => e);
      expect(parseLoginRequired((wrong as Error).message)).toEqual({ key: "username", reason: "Suwayomi turned down this username and password." });
    }
    const none = await setup(OPEN, { auth: "BASIC_AUTH" }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((none as Error).message)?.reason).toBe("Suwayomi needs a username and password.");
  });
});

describe("lists", () => {
  test("Recently updated, the library by category, then sources: Local first, searchable", async () => {
    const lists = await setup().bridge.getLists!();
    for (const l of lists) expect(() => seriesListSchema.parse(l)).not.toThrow();
    expect(lists.map((l) => l.id)).toEqual(["updated", "library:default", "library:2", `source:${LOCAL}`, `source:${ONLINE}`, `source:${NSFW_SOURCE}`]);
    expect(lists.map((l) => l.name)).toEqual(["Recently updated", "Default", "Reading", "Local source", "MangaDex (EN)", "Spicy (EN)"]);
    expect(lists[3]).toMatchObject({ searchable: true, description: "Files on the server" });
  });

  test("an empty library leaves out its lists", async () => {
    const { bridge, suwayomi } = setup();
    for (const m of suwayomi.mangas) m.inLibrary = false;
    expect((await bridge.getLists!()).map((l) => l.id)).toEqual([`source:${LOCAL}`, `source:${ONLINE}`, `source:${NSFW_SOURCE}`]);
  });

  test("Recently updated: one card per series, by its newest chapter", async () => {
    const { items } = await setup().bridge.getListItems!("updated");
    expect(items.map((i) => [i.id, i.subtitle])).toEqual([["5", "Ch. 2"], ["6", "Ch. 1"]]);
  });

  test("library cards name their source and unread count", async () => {
    const { bridge, suwayomi } = setup();
    suwayomi.read.add(51);
    const { items } = await bridge.getListItems!("library:2");
    for (const i of items) expect(() => seriesEntrySchema.parse(i)).not.toThrow();
    expect(items).toEqual([
      {
        id: "5",
        title: "Online Series",
        thumbnailUrl: `${ORIGIN}/api/v1/manga/5/thumbnail`,
        subtitle: "MangaDex (EN)",
        badges: [{ text: "2", position: "top-right", tone: "info" }],
      },
    ]);
    expect((await bridge.getListItems!("library:default")).items.map((i) => i.id)).toEqual(["6"]);
  });

  test("a source pages, and searches within itself", async () => {
    const { bridge, suwayomi } = setup();
    const first = await bridge.getListItems!(`source:${ONLINE}`);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe("1");
    const second = await bridge.getListItems!(`source:${ONLINE}`, { cursor: "1" });
    expect(second.nextCursor).toBeUndefined();
    expect(JSON.parse(suwayomi.requests.at(-1)!.body!).variables.input).toEqual({ source: ONLINE, type: "POPULAR", page: 2 });
    const found = await bridge.getListItems!(`source:${ONLINE}`, { query: "online" });
    expect(found.items.map((i) => i.title)).toEqual(["Online Series"]);
  });

  test("a series from an NSFW source is marked adult", async () => {
    const { items } = await setup().bridge.getListItems!(`source:${NSFW_SOURCE}`);
    expect(items[0]).toMatchObject({ id: "7", contentRating: "adult" });
  });

  test("an unknown list or cursor is refused", async () => {
    const { bridge } = setup();
    await expect(bridge.getListItems!("library:x")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("source:abc")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("nope")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("updated", { cursor: "-1" })).rejects.toThrow(/bad cursor/);
  });
});

describe("search", () => {
  test("covers the library and each source, each series once; a failing source is skipped", async () => {
    const { bridge } = setup(OPEN, { failSources: [NSFW_SOURCE] });
    const { items } = await bridge.getSearchResults!({ text: "series" });
    expect(items.map((i) => i.id)).toEqual(["5", "6"]);
    expect((await bridge.getSearchResults!({ text: "pepper" })).items.map((i) => i.title)).toEqual(["Pepper&Carrot"]);
  });

  test("an empty query lists the library", async () => {
    expect((await setup().bridge.getSearchResults!({ text: "" })).items.map((i) => i.id)).toEqual(["5", "6"]);
  });
});

describe("a series", () => {
  test("details carry Suwayomi's metadata", async () => {
    const info = await setup().bridge.getSeriesDetails("5");
    expect(() => seriesInfoSchema.parse(info)).not.toThrow();
    expect(info).toEqual({
      id: "5",
      title: "Online Series",
      thumbnailUrl: `${ORIGIN}/api/v1/manga/5/thumbnail`,
      author: "Jane Writer, Ann Artist",
      authors: [{ name: "Jane Writer" }, { name: "Ann Artist" }],
      description: "An online series.",
      status: "completed",
      languages: ["en"],
      tagGroups: [{ label: "Genres", kind: "genre", tags: ["Action", "Comedy"] }],
      infoCells: [{ label: "Source", value: "MangaDex (EN)" }],
      shareUrl: "https://mangadex.org/title/abc",
    });
  });

  test("a series the server never opened is fetched from its source first", async () => {
    const { bridge, suwayomi } = setup();
    expect((await bridge.getSeriesDetails("1")).title).toBe("Pepper&Carrot");
    expect(suwayomi.requests.some((r) => r.body?.includes("fetchManga: true"))).toBe(true);
  });

  test("chapters in source order, with numbers, groups and dates where known", async () => {
    const chapters = await setup().bridge.getChapters!("5");
    for (const c of chapters) expect(() => chapterSchema.parse(c)).not.toThrow();
    expect(chapters).toEqual([
      { id: "50", name: "Extra" },
      { id: "51", name: "Ch. 1", number: 1, publishedAt: 1700000000000 },
      { id: "52", name: "Ch. 2", number: 2, group: "Team A" },
    ]);
  });

  test("with its source down, chapters come from what the server already has", async () => {
    const { bridge } = setup(OPEN, { failSources: [ONLINE] });
    expect((await bridge.getChapters!("5")).map((c) => c.id)).toEqual(["50", "51", "52"]);
  });

  test("a series removed from Suwayomi says so", async () => {
    const { bridge } = setup();
    await expect(bridge.getSeriesDetails("999")).rejects.toThrow("[series-gone]");
    await expect(bridge.getChapters!("999")).rejects.toThrow("[series-gone]");
    await expect(bridge.getChapters!("1 OR 1")).rejects.toThrow(/not a Suwayomi id/);
  });

  test("pages are the server's page URLs", async () => {
    const pages = await setup().bridge.getChapterPages!("5", "52");
    for (const p of pages) expect(() => pageSchema.parse(p)).not.toThrow();
    expect(pages.map((p) => p.imageUrl)).toEqual([0, 1, 2, 3].map((i) => `${ORIGIN}/api/v1/manga/5/chapter/2/page/${i}`));
  });
});

describe("read-sync", () => {
  test("marks chapters read and unread, and reads back what is read", async () => {
    const { bridge, suwayomi } = setup();
    expect(await bridge.getReadChapters!("5")).toEqual([]);
    await bridge.markChapterRead!("5", "51");
    expect(suwayomi.read.has(51)).toBe(true);
    expect(await bridge.getReadChapters!("5")).toEqual(["51"]);
    await bridge.markChapterUnread!("5", "51");
    expect(await bridge.getReadChapters!("5")).toEqual([]);
  });
});

describe("links", () => {
  test("open Suwayomi's manga and reader pages", async () => {
    const { bridge } = setup();
    expect(await bridge.resolveUrl!(`${ORIGIN}/manga/5`)).toEqual({ seriesId: "5" });
    // The reader's chapter number is the chapter's place in the source.
    expect(await bridge.resolveUrl!(`${ORIGIN}/manga/5/chapter/2`)).toEqual({ seriesId: "5", chapterId: "52" });
    expect(await bridge.resolveUrl!(`${ORIGIN}/library`)).toBeNull();
    expect(await bridge.resolveUrl!("http://elsewhere/manga/5")).toBeNull();
  });
});

describe("settings", () => {
  test("the form is valid and warns only for a password over public http", async () => {
    const footer = async (settings: Record<string, string>) => {
      const form = await setup(settings).bridge.loadSettings!();
      expect(() => settingsFormSchema.parse(form)).not.toThrow();
      return form.sections[1]?.footer;
    };
    expect(await footer(SIGNED_IN)).toMatch(/Simple login isn't supported/);
    expect(await footer({ serverUrl: "http://comics.example.com", username: USER, password: PASS })).toMatch(/unencrypted/);
  });

  test("Test connection names the server and its sources, or what is wrong", async () => {
    expect(await setup().bridge.runSettingAction!("test")).toEqual({
      ok: true,
      message: "Connected to Suwayomi-Server v2.4.2366, with 3 sources.",
    });
    expect(await setup({ ...SIGNED_IN, password: "x" }, { auth: "BASIC_AUTH" }).bridge.runSettingAction!("test")).toEqual({
      ok: false,
      message: "Suwayomi turned down this username and password.",
    });
    expect(await setup({}).bridge.runSettingAction!("test")).toEqual({ ok: false, message: "Enter Suwayomi's address first." });
  });
});

test("passes the testkit conformance checks", async () => {
  await runConformance(setup().bridge, { searchQuery: "series" });
});
