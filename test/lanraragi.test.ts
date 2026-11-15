import { describe, expect, test } from "bun:test";
import {
  bridgeInfoSchema,
  pageSchema,
  parseLoginRequired,
  seriesEntrySchema,
  seriesInfoSchema,
  seriesListSchema,
  settingsFormSchema,
} from "@comical/contract";
import { mockHost, runConformance } from "@comical/testkit";
import factory, { lanraragiBase } from "../src/lanraragi.ts";
import { ARC, KEY, type LanraragiOptions, PER_PAGE, lanraragiServer } from "./fixtures/lanraragi-server.ts";

const ORIGIN = "http://lrr.lan:3000";
const OPEN = { serverUrl: ORIGIN };
const KEYED = { serverUrl: ORIGIN, apiKey: KEY };
const BEARER = `Bearer ${btoa(KEY)}`;

function setup(settings: Record<string, string> = KEYED, server: LanraragiOptions = {}) {
  const lrr = lanraragiServer(ORIGIN, server);
  const host = mockHost({ handle: lrr.handle, settings });
  return { lrr, host, bridge: factory(host) };
}

describe("server address", () => {
  test.each([
    ["192.168.1.5:3000", "http://192.168.1.5:3000"],
    [`http://nas:3000/reader?id=${ARC(1)}`, "http://nas:3000"],
    ["https://example.com/lrr/index", "https://example.com/lrr"],
  ])("%s → %s", (typed, base) => {
    expect(lanraragiBase(typed)).toBe(base);
  });
});

describe("info", () => {
  test("is a valid NSFW, direct bridge; the key never appears in it", () => {
    const info = setup().bridge.info;
    expect(() => bridgeInfoSchema.parse(info)).not.toThrow();
    expect(info).toMatchObject({ id: "porksphere.lanraragi", nsfw: true });
    expect(info.capabilities).toEqual(["direct", "lists", "search", "settings", "read-sync"]);
    expect(info.images).toEqual({ hosts: ["lrr.lan"], intercept: ["lrr.lan"] });
    expect(JSON.stringify(info)).not.toContain(KEY);
    expect(setup(OPEN).bridge.info.images).toEqual({ hosts: ["lrr.lan"] });
  });
});

describe("sign-in", () => {
  test("the key goes as LANraragi wants it, on every call and image", async () => {
    const { bridge, lrr } = setup();
    await bridge.getLists!();
    for (const r of lrr.requests) expect(r.headers?.Authorization).toBe(BEARER);
    expect((await bridge.interceptImageRequest!(`${ORIGIN}/api/archives/${ARC(1)}/thumbnail`)).headers).toEqual({ Authorization: BEARER });
  });

  test("an open server reads without a key", async () => {
    const { bridge, lrr } = setup(OPEN);
    expect((await bridge.getLists!()).length).toBeGreaterThan(0);
    for (const r of lrr.requests) expect(r.headers?.Authorization).toBeUndefined();
  });

  test("No-Fun Mode without the key, or a wrong key, names the setting to fix", async () => {
    const none = await setup(OPEN, { nofun: true }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((none as Error).message)).toEqual({ key: "apiKey", reason: "This LANraragi needs its API key." });
    const wrong = await setup({ serverUrl: ORIGIN, apiKey: "x" }, { nofun: true }).bridge.getLists!().catch((e: Error) => e);
    expect(parseLoginRequired((wrong as Error).message)?.reason).toBe("LANraragi turned down this API key.");
  });
});

describe("lists", () => {
  test("Continue reading, New, Recently added, categories with something in them (pinned first), All", async () => {
    const lists = await setup().bridge.getLists!();
    for (const l of lists) expect(() => seriesListSchema.parse(l)).not.toThrow();
    expect(lists.map((l) => l.id)).toEqual(["continue", "new", "recent", "category:SET_3", "category:SET_2", "all"]);
    expect(lists.find((l) => l.id === "all")).toMatchObject({ searchable: true });
  });

  test("Continue reading holds archives started and not finished", async () => {
    expect((await setup().bridge.getListItems!("continue")).items.map((i) => i.id)).toEqual([ARC(2)]);
  });

  test("cards: the artist as subtitle, a New badge, rated adult", async () => {
    const { items } = await setup().bridge.getListItems!("new");
    for (const i of items) expect(() => seriesEntrySchema.parse(i)).not.toThrow();
    expect(items).toEqual([
      {
        id: ARC(1),
        title: "Test Doujin",
        thumbnailUrl: `${ORIGIN}/api/archives/${ARC(1)}/thumbnail`,
        subtitle: "jane doe",
        badges: [{ text: "New", position: "top-right", tone: "info" }],
        contentRating: "adult",
      },
    ]);
  });

  test("lists page at the server's page size", async () => {
    const { bridge } = setup();
    const first = await bridge.getListItems!("all");
    expect(first.items).toHaveLength(PER_PAGE);
    expect(first.nextCursor).toBe(String(PER_PAGE));
    const second = await bridge.getListItems!("all", { cursor: first.nextCursor! });
    expect(second.items).toHaveLength(15 - PER_PAGE);
    expect(second.nextCursor).toBeUndefined();
  });

  test("static and dynamic categories, and searching All", async () => {
    const { bridge } = setup();
    expect((await bridge.getListItems!("category:SET_2")).items.map((i) => i.id).sort()).toEqual([ARC(1), ARC(2)]);
    expect((await bridge.getListItems!("category:SET_3")).items.map((i) => i.title)).toEqual(["Finished Book", "Started Book"]);
    expect((await bridge.getListItems!("all", { query: "doujin" })).items.map((i) => i.id)).toEqual([ARC(1)]);
  });

  test("an unknown list or cursor is refused", async () => {
    const { bridge } = setup();
    await expect(bridge.getListItems!("category:../x")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("nope")).rejects.toThrow(/unknown list/);
    await expect(bridge.getListItems!("all", { cursor: "x" })).rejects.toThrow(/bad cursor/);
  });
});

describe("search", () => {
  test("uses LANraragi's filter, tags included", async () => {
    const { bridge, lrr } = setup();
    expect((await bridge.getSearchResults!({ text: "artist:ann" })).items.map((i) => i.id)).toEqual([ARC(1)]);
    expect(lrr.requests.find((r) => r.url.includes("/api/search"))!.url).toContain("filter=artist%3Aann");
  });
});

describe("an archive", () => {
  test("details: tags become credits, groups and info", async () => {
    const info = await setup().bridge.getSeriesDetails(ARC(1));
    expect(() => seriesInfoSchema.parse(info)).not.toThrow();
    expect(info).toEqual({
      id: ARC(1),
      title: "Test Doujin",
      thumbnailUrl: `${ORIGIN}/api/archives/${ARC(1)}/thumbnail`,
      author: "jane doe, ann",
      authors: [{ name: "jane doe" }, { name: "ann" }],
      description: "A summary.",
      contentRating: "adult",
      pageCount: 5,
      tagGroups: [
        { label: "Parody", tags: ["original"] },
        { label: "Characters", tags: ["alice"] },
        { label: "Group", tags: ["circle a"] },
        { label: "Tags", kind: "other", tags: ["female:glasses", "misc"] },
      ],
      infoCells: [
        { label: "Pages", value: "5" },
        { label: "Language", value: "english" },
        { label: "Added", value: "2026-11-15" },
      ],
      shareUrl: "https://example.com/g/1",
    });
  });

  test("without an artist, the group is credited; without a source, the link is the reader", async () => {
    const info = await setup().bridge.getSeriesDetails(ARC(2));
    expect(info.author).toBe("circle b");
    expect(info.shareUrl).toBe(`${ORIGIN}/reader?id=${ARC(2)}`);
  });

  test("pages are the archive's files, on the server", async () => {
    const pages = await setup().bridge.getSeriesPages!(ARC(1));
    for (const p of pages) expect(() => pageSchema.parse(p)).not.toThrow();
    expect(pages.map((p) => p.imageUrl)).toEqual([0, 1, 2, 3, 4].map((i) => `${ORIGIN}/api/archives/${ARC(1)}/page?path=00${i}.jpg`));
  });

  test("an archive removed from LANraragi says so", async () => {
    const { bridge } = setup();
    await expect(bridge.getSeriesDetails(ARC(999))).rejects.toThrow("[series-gone]");
    await expect(bridge.getSeriesPages!(ARC(999))).rejects.toThrow("[series-gone]");
    await expect(bridge.getSeriesDetails("../../api/info")).rejects.toThrow(/not a LANraragi archive id/);
  });
});

describe("read-sync", () => {
  test("finishing sets progress to the last page and clears New; unread resets it", async () => {
    const { bridge, lrr } = setup();
    const a = () => lrr.archives.find((x) => x.arcid === ARC(1))!;
    expect(await bridge.getReadChapters!(ARC(1))).toEqual([]);
    await bridge.markChapterRead!(ARC(1), "__direct__");
    expect([a().progress, a().isnew]).toEqual([5, false]);
    expect(await bridge.getReadChapters!(ARC(1))).toEqual(["__direct__"]);
    await bridge.markChapterUnread!(ARC(1), "__direct__");
    expect(a().progress).toBe(0);
    expect(await bridge.getReadChapters!(ARC(1))).toEqual([]);
  });

  test("an archive at its last page reads back as read; one part-way doesn't", async () => {
    const { bridge } = setup();
    expect(await bridge.getReadChapters!(ARC(3))).toEqual(["__direct__"]);
    expect(await bridge.getReadChapters!(ARC(2))).toEqual([]);
  });

  test("without the key, progress still syncs where the server allows it; New stays", async () => {
    const { bridge, lrr } = setup(OPEN);
    await bridge.markChapterRead!(ARC(1), "__direct__");
    expect(lrr.archives[0]).toMatchObject({ progress: 5, isnew: true });
    const guarded = setup(OPEN, { authenticatedProgress: true });
    const err = await guarded.bridge.markChapterRead!(ARC(1), "__direct__").catch((e: Error) => e);
    expect(parseLoginRequired((err as Error).message)?.key).toBe("apiKey");
  });
});

describe("links", () => {
  test("open the reader and edit pages", async () => {
    const { bridge } = setup();
    expect(await bridge.resolveUrl!(`${ORIGIN}/reader?id=${ARC(1)}`)).toEqual({ seriesId: ARC(1) });
    expect(await bridge.resolveUrl!(`${ORIGIN}/edit?id=${ARC(1).toUpperCase()}`)).toEqual({ seriesId: ARC(1) });
    expect(await bridge.resolveUrl!(`${ORIGIN}/index`)).toBeNull();
    expect(await bridge.resolveUrl!(`http://elsewhere/reader?id=${ARC(1)}`)).toBeNull();
  });
});

describe("settings", () => {
  test("the form is valid and warns only for a key over public http", async () => {
    const footer = async (settings: Record<string, string>) => {
      const form = await setup(settings).bridge.loadSettings!();
      expect(() => settingsFormSchema.parse(form)).not.toThrow();
      return form.sections[1]?.footer;
    };
    expect(await footer(KEYED)).toBeUndefined();
    expect(await footer({ serverUrl: "http://lrr.example.com", apiKey: KEY })).toMatch(/your API key is sent unencrypted/);
  });

  test("Test connection checks the server and the key", async () => {
    expect(await setup().bridge.runSettingAction!("test")).toEqual({ ok: true, message: "Connected to LANraragi 0.9.82, 15 archives." });
    expect(await setup(OPEN).bridge.runSettingAction!("test")).toEqual({
      ok: true,
      message: "Connected to LANraragi 0.9.82, 15 archives. Add the API key to sync reading progress.",
    });
    expect(await setup({ serverUrl: ORIGIN, apiKey: "x" }).bridge.runSettingAction!("test")).toEqual({
      ok: false,
      message: "LANraragi turned down this API key.",
    });
    expect(await setup({}).bridge.runSettingAction!("test")).toEqual({ ok: false, message: "Enter LANraragi's address first." });
  });
});

test("passes the testkit conformance checks", async () => {
  await runConformance(setup().bridge, { searchQuery: "book" });
});
