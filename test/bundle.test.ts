/**
 * The built bundles, loaded the way every host loads them: evaluated in the core's sandbox, with
 * BridgeInfo and every result validated at the boundary. Catches what only breaks once bundled
 * (a Node API pulled in, a module the sandbox can't see). Needs `bun run build` first.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBridge } from "@comical/core";
import { mockHost } from "@comical/testkit";
import { basicAuth } from "../src/core/server.ts";
import { BOOK, SERIES_A, komgaServer } from "./fixtures/komga-server.ts";
import { opdsServer } from "./fixtures/opds-server.ts";

const bundle = (id: string): string => {
  const path = join(import.meta.dir, "..", ".build", id, "dist", "bridge.js");
  if (!existsSync(path)) throw new Error(`${path} is missing: run \`bun run build\` before the tests`);
  return readFileSync(path, "utf8");
};

describe("opds bundle", () => {
  test("loads in the sandbox and reads a book end to end", async () => {
    const server = opdsServer();
    const bridge = await loadBridge({
      code: bundle("opds"),
      expectedId: "porksphere.opds",
      capabilities: mockHost({
        handle: server.handle,
        settings: { catalogUrl: "http://komga.lan:25600/opds/v1.2/catalog" },
      }),
    });
    const lists = await bridge.getLists!();
    const latest = lists.find((l) => l.name === "Latest series")!;
    const series = (await bridge.getListItems!(latest.id)).items[0]!;
    const [chapter] = await bridge.getChapters!(series.id);
    const pages = await bridge.getChapterPages!(series.id, chapter!.id);
    expect(pages).toHaveLength(4);
  });
});

describe("komga bundle", () => {
  test("loads in the sandbox, reads a book, and syncs it read", async () => {
    const auth = basicAuth("reader@example.com", "hunter2");
    const komga = komgaServer("http://komga.lan:25600", { authorization: auth });
    const bridge = await loadBridge({
      code: bundle("komga"),
      expectedId: "porksphere.komga",
      capabilities: mockHost({
        handle: komga.handle,
        settings: { serverUrl: "http://komga.lan:25600", username: "reader@example.com", password: "hunter2" },
      }),
    });
    const { items } = await bridge.getSearchResults!({ text: "series a" });
    const [chapter] = await bridge.getChapters!(items[0]!.id);
    expect(await bridge.getChapterPages!(SERIES_A, chapter!.id)).toHaveLength(4);
    await bridge.markChapterRead!(SERIES_A, chapter!.id);
    expect(await bridge.getReadChapters!(SERIES_A)).toEqual([BOOK(SERIES_A, 1)]);
  });
});
