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
import factory from "../src/opds.ts";
import { basicAuth } from "../src/core/server.ts";
import { opdsServer } from "./fixtures/opds-server.ts";

const ORIGIN = "http://komga.lan:25600";
const CATALOG = `${ORIGIN}/opds/v1.2/catalog`;

function setup(settings: Record<string, string> = { catalogUrl: CATALOG }, auth?: string) {
  const server = opdsServer(ORIGIN, auth);
  const host = mockHost({ handle: server.handle, settings });
  return { server, host, bridge: factory(host) };
}

async function listByName(bridge: ReturnType<typeof factory>, name: string) {
  const list = (await bridge.getLists!()).find((l) => l.name === name);
  if (!list) throw new Error(`no list named ${name}`);
  return list;
}

describe("info", () => {
  test("is valid, and declares no images until a catalog is set", () => {
    const { bridge } = setup({});
    expect(() => bridgeInfoSchema.parse(bridge.info)).not.toThrow();
    expect(bridge.info.images).toBeUndefined();
  });

  test("without credentials, images load straight from the server", () => {
    const { bridge } = setup();
    expect(bridge.info.images).toEqual({ hosts: ["komga.lan"] });
  });

  test("with credentials, images are intercepted and the credentials never appear in info", () => {
    const { bridge } = setup({ catalogUrl: CATALOG, username: "reader", password: "hunter2" });
    expect(bridge.info.images).toEqual({ hosts: ["komga.lan"], intercept: ["komga.lan"] });
    const json = JSON.stringify(bridge.info);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain(basicAuth("reader", "hunter2").slice(6));
  });

  test("a bare host:port is read as an http:// address", async () => {
    const { bridge } = setup({ catalogUrl: "komga.lan:25600/opds/v1.2/catalog" });
    expect((await bridge.getLists!()).length).toBeGreaterThan(0);
  });
});

describe("lists", () => {
  test("come from the root's navigation: books, series, and one list per category", async () => {
    const { bridge } = setup();
    const lists = await bridge.getLists!();
    for (const l of lists) expect(() => seriesListSchema.parse(l)).not.toThrow();
    expect(lists.map((l) => l.name)).toEqual(["Keep reading", "Latest series", "Manga", "Comics"]);
    expect(lists.find((l) => l.name === "Manga")?.description).toBe("Libraries");
  });

  test("an entry whose feed fails is left out, not fatal", async () => {
    const { bridge } = setup();
    expect((await bridge.getLists!()).map((l) => l.name)).not.toContain("Broken");
  });

  test("are cached: a second call and a fresh instance on the same storage fetch nothing", async () => {
    const { bridge, server, host } = setup();
    await bridge.getLists!();
    const after = server.requests.length;
    await bridge.getLists!();
    await factory(host).getLists!();
    expect(server.requests.length).toBe(after);
  });

  test("a series list holds series, with absolute covers", async () => {
    const { bridge } = setup();
    const page = await bridge.getListItems!((await listByName(bridge, "Latest series")).id);
    for (const e of page.items) expect(() => seriesEntrySchema.parse(e)).not.toThrow();
    expect(page.items.map((e) => e.title)).toEqual(["Test Series A", "Test Series B"]);
    expect(page.items[0]?.thumbnailUrl).toBe(`${ORIGIN}/opds/v1.2/series/a/thumbnail`);
    expect(page.nextCursor).toBeUndefined();
  });

  test("pages through rel=next with a cursor", async () => {
    const { bridge } = setup();
    const manga = await listByName(bridge, "Manga");
    const first = await bridge.getListItems!(manga.id);
    expect(first.items.map((e) => e.title)).toEqual(["Test Series A"]);
    expect(first.nextCursor).toBeDefined();
    const second = await bridge.getListItems!(manga.id, { cursor: first.nextCursor });
    expect(second.items.map((e) => e.title)).toEqual(["Test Series B"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("a series feed", () => {
  async function seriesA() {
    const ctx = setup();
    const page = await ctx.bridge.getListItems!((await listByName(ctx.bridge, "Latest series")).id);
    return { ...ctx, id: page.items[0]!.id };
  }

  test("details use what the card showed, with the books' author", async () => {
    const { bridge, id } = await seriesA();
    const info = await bridge.getSeriesDetails(id);
    expect(() => seriesInfoSchema.parse(info)).not.toThrow();
    expect(info.title).toBe("Test Series A");
    expect(info.thumbnailUrl).toBe(`${ORIGIN}/opds/v1.2/series/a/thumbnail`);
    expect(info.author).toBe("Jane Artist");
  });

  test("chapters are its books, across pages, in feed order", async () => {
    const { bridge, id } = await seriesA();
    const chapters = await bridge.getChapters!(id);
    for (const c of chapters) expect(() => chapterSchema.parse(c)).not.toThrow();
    expect(chapters.map((c) => c.name)).toEqual([
      "Test Series A v01",
      "Test Series A v02",
      "Test Series A v03",
      "Test Series A extras",
    ]);
    expect(chapters.map((c) => c.pageCount)).toEqual([4, 3, 5, undefined]);
    expect(chapters[0]?.publishedAt).toBe(Date.parse("2024-05-01"));
  });

  test("pages are the PSE stream, zero-based, on the server", async () => {
    const { bridge, id } = await seriesA();
    const [first] = await bridge.getChapters!(id);
    const pages = await bridge.getChapterPages!(id, first!.id);
    for (const p of pages) expect(() => pageSchema.parse(p)).not.toThrow();
    expect(pages.map((p) => p.imageUrl)).toEqual(
      [0, 1, 2, 3].map((i) => `${ORIGIN}/opds/v1.2/books/1/pages/${i}?zero_based=true`),
    );
  });

  test("a book with only a download is listed but says why it can't open", async () => {
    const { bridge, id } = await seriesA();
    const extras = (await bridge.getChapters!(id)).at(-1)!;
    expect(bridge.getChapterPages!(id, extras.id)).rejects.toThrow(/OPDS-PSE/);
  });

  test("a series opened without its card still gets a title and cover from the feed", async () => {
    const { bridge, id } = await seriesA();
    const fresh = factory(mockHost({ handle: opdsServer(ORIGIN).handle, settings: { catalogUrl: CATALOG } }));
    const info = await fresh.getSeriesDetails(id);
    expect(info.title).toBe("Test Series A");
    expect(info.thumbnailUrl).toBe(`${ORIGIN}/opds/v1.2/books/1/thumbnail/small`);
  });
});

describe("a book met outside its series", () => {
  test("is a series of one chapter that reads its stream", async () => {
    const { bridge } = setup();
    const page = await bridge.getListItems!((await listByName(bridge, "Keep reading")).id);
    const book = page.items[0]!;
    expect(book.title).toBe("Test Series A v01");
    const info = await bridge.getSeriesDetails(book.id);
    expect(info.title).toBe("Test Series A v01");
    expect(info.description).toBe("Volume 1 & more");
    const chapters = await bridge.getChapters!(book.id);
    expect(chapters).toHaveLength(1);
    expect((await bridge.getChapterPages!(book.id, chapters[0]!.id))).toHaveLength(4);
  });
});

describe("search", () => {
  test("follows the OpenSearch description's template", async () => {
    const { bridge } = setup();
    const results = await bridge.getSearchResults!({ text: "series a" });
    expect(results.items.map((e) => e.title)).toEqual(["Test Series A"]);
  });

  test("a catalog without search says so", async () => {
    const server = opdsServer(ORIGIN);
    const host = mockHost({
      handle: (req) => {
        const res = server.handle(req);
        return new URL(req.url).pathname === "/opds/v1.2/catalog"
          ? { ...res, body: res.body.replace(/<link rel="search"[^>]*\/>/, "") }
          : res;
      },
      settings: { catalogUrl: CATALOG },
    });
    expect(factory(host).getSearchResults!({ text: "x" })).rejects.toThrow(/doesn't offer search/);
  });
});

describe("sign-in", () => {
  const AUTH = basicAuth("reader", "hunter2");

  test("every catalog request carries the credentials", async () => {
    const { bridge, server } = setup({ catalogUrl: CATALOG, username: "reader", password: "hunter2" }, AUTH);
    await bridge.getLists!();
    expect(server.requests.length).toBeGreaterThan(0);
    for (const r of server.requests) expect(r.headers?.Authorization).toBe(AUTH);
  });

  test("images get the credentials at fetch time", async () => {
    const { bridge } = setup({ catalogUrl: CATALOG, username: "reader", password: "hunter2" });
    const req = await bridge.interceptImageRequest!(`${ORIGIN}/opds/v1.2/books/1/pages/0`);
    expect(req.headers?.Authorization).toBe(AUTH);
  });

  test("a refused request asks the user to sign in", async () => {
    const { bridge } = setup({ catalogUrl: CATALOG }, AUTH);
    const err = await bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((err as Error).message)?.key).toBe("username");
  });
});

describe("settings", () => {
  test("the form is valid and warns only for credentials over public http", async () => {
    const footers = async (settings: Record<string, string>) => {
      const form = await setup(settings).bridge.loadSettings!();
      expect(() => settingsFormSchema.parse(form)).not.toThrow();
      return form.sections[1]?.footer;
    };
    const creds = { username: "reader", password: "hunter2" };
    expect(await footers({ catalogUrl: CATALOG, ...creds })).toBeUndefined();
    expect(await footers({ catalogUrl: "http://comics.example.com/opds", ...creds })).toMatch(/unencrypted/);
    expect(await footers({ catalogUrl: "https://comics.example.com/opds", ...creds })).toBeUndefined();
    expect(await footers({ catalogUrl: "http://comics.example.com/opds" })).toBeUndefined();
  });

  test("Test connection names the catalog, or says what went wrong", async () => {
    expect(await setup().bridge.runSettingAction!("test")).toEqual({
      ok: true,
      message: "Connected to “Komga OPDS catalog”.",
    });
    const bad = await setup({ catalogUrl: `${ORIGIN}/nope` }).bridge.runSettingAction!("test");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("404");
  });
});

test("ids survive the server moving to a new address", async () => {
  const { bridge } = setup();
  const page = await bridge.getListItems!((await listByName(bridge, "Latest series")).id);
  const id = page.items[0]!.id;
  const moved = "https://comics.example.com";
  const host = mockHost({
    handle: opdsServer(moved).handle,
    settings: { catalogUrl: `${moved}/opds/v1.2/catalog` },
  });
  expect((await factory(host).getChapters!(id)).length).toBe(4);
});

test("passes the testkit conformance checks", async () => {
  const { bridge } = setup();
  await runConformance(bridge, { searchQuery: "series a" });
});
