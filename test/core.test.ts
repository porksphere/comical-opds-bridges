import { describe, expect, test } from "bun:test";
import type { CheerioRoot } from "@comical/sdk";
import * as cheerio from "../../comical/packages/sdk/node_modules/cheerio";
import { absoluteFromOrigin, decodeId, encodeId, idKind, relativeToOrigin } from "../src/core/ids.ts";
import { insecureCredentialsWarning, isPrivateHost } from "../src/core/network-safety.ts";
import { authorizedImage, basicAuth, normalizeServerUrl, serverImages } from "../src/core/server.ts";
import { coverOf, isPublication, navigationHref, parseFeed, pseStreamOf } from "../src/core/opds/feed.ts";
import { fillSearchTemplate, templateFromDescription } from "../src/core/opds/search.ts";

// The SDK's own cheerio, as a bridge reaches it; resolved by path, its types are a second copy.
const load = (xml: string) => cheerio.load(xml, { xml: true }) as unknown as CheerioRoot;

describe("server", () => {
  test("normalizes what a user types", () => {
    expect(normalizeServerUrl(" 192.168.1.5:25600/ ")).toBe("http://192.168.1.5:25600");
    expect(normalizeServerUrl("https://komga.example.com/opds/v1.2/catalog/")).toBe(
      "https://komga.example.com/opds/v1.2/catalog",
    );
    expect(() => normalizeServerUrl("ftp://x")).toThrow(/http/);
  });

  test("basic auth is UTF-8 safe", () => {
    expect(basicAuth("ü", "p")).toBe(`Basic ${Buffer.from("ü:p").toString("base64")}`);
  });

  test("images and their interception", () => {
    expect(serverImages(undefined, true)).toBeUndefined();
    expect(serverImages("http://[::1]:8080/x", false)).toEqual({ hosts: ["::1"] });
    expect(authorizedImage("http://h/x", undefined)).toEqual({ url: "http://h/x" });
    expect(authorizedImage("http://h/x", "Basic a")).toEqual({ url: "http://h/x", headers: { Authorization: "Basic a" } });
  });
});

describe("network safety", () => {
  test.each([
    ["localhost", true],
    ["nas", true],
    ["komga.local", true],
    ["box.tail1234.ts.net", true],
    ["10.0.0.4", true],
    ["172.20.1.1", true],
    ["172.32.1.1", false],
    ["192.168.1.5", true],
    ["100.101.102.103", true],
    ["100.128.0.1", false],
    ["::1", true],
    ["fd12:3456::1", true],
    ["8.8.8.8", false],
    ["comics.example.com", false],
  ])("%s private: %p", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  test("warns only for credentials over public http", () => {
    expect(insecureCredentialsWarning("http://comics.example.com", true)).toMatch(/unencrypted/);
    expect(insecureCredentialsWarning("http://comics.example.com", false)).toBeUndefined();
    expect(insecureCredentialsWarning("https://comics.example.com", true)).toBeUndefined();
    expect(insecureCredentialsWarning("http://100.64.0.1:25600", true)).toBeUndefined();
    expect(insecureCredentialsWarning(undefined, true)).toBeUndefined();
  });
});

describe("ids", () => {
  test("round-trip with a kind, and refuse another kind", () => {
    const id = encodeId("f", { u: "/opds/v1.2/series/ä?x=1" });
    expect(id).toMatch(/^f\.[A-Za-z0-9_-]+$/);
    expect(idKind(id)).toBe("f");
    expect(decodeId<{ u: string }>("f", id).u).toBe("/opds/v1.2/series/ä?x=1");
    expect(() => decodeId("b", id)).toThrow(/not a b id/);
    expect(() => decodeId("f", "f.!!!")).toThrow(/malformed/);
  });

  test("urls are kept relative to the server's origin", () => {
    expect(relativeToOrigin("http://h:1/a/b?c=1", "http://h:1/opds")).toBe("/a/b?c=1");
    expect(relativeToOrigin("http://cdn/a", "http://h:1/opds")).toBe("http://cdn/a");
    expect(absoluteFromOrigin("/a/b?c=1", "https://new/opds")).toBe("https://new/a/b?c=1");
  });
});

describe("feed parsing", () => {
  const xml = `<?xml version="1.0"?>
    <atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns">
      <atom:title>Prefixed &amp; fine</atom:title>
      <atom:entry>
        <atom:title>A book</atom:title>
        <atom:summary type="html">&lt;p&gt;Some &lt;b&gt;bold&lt;/b&gt; text&lt;/p&gt;</atom:summary>
        <atom:link rel="http://opds-spec.org/image/thumbnail" href="t.jpg"/>
        <atom:link rel="http://vaemendis.net/opds-pse/stream" href="p/{pageNumber}/{maxWidth}" pse:count="7"/>
      </atom:entry>
      <atom:entry>
        <atom:title>A folder</atom:title>
        <atom:link href="sub" type="application/atom+xml;profile=opds-catalog"/>
      </atom:entry>
      <atom:entry>
        <atom:title>Bad count</atom:title>
        <atom:link rel="http://vaemendis.net/opds-pse/stream" href="q/{pageNumber}" pse:count="0"/>
      </atom:entry>
    </atom:feed>`;
  const feed = parseFeed(xml, "http://h/opds/root", load);

  test("reads a feed that prefixes the Atom namespace", () => {
    expect(feed.title).toBe("Prefixed & fine");
    expect(feed.entries.map((e) => e.title)).toEqual(["A book", "A folder", "Bad count"]);
  });

  test("html summaries lose their markup", () => {
    expect(feed.entries[0]?.summary).toBe("Some bold text");
  });

  test("resolves hrefs and keeps the PSE placeholders", () => {
    expect(coverOf(feed.entries[0]!)).toBe("http://h/opds/t.jpg");
    expect(pseStreamOf(feed.entries[0]!)).toEqual({ template: "http://h/opds/p/{pageNumber}/{maxWidth}", count: 7 });
    expect(pseStreamOf(feed.entries[2]!)).toBeUndefined();
  });

  test("tells publications from navigation", () => {
    expect(isPublication(feed.entries[0]!)).toBe(true);
    expect(navigationHref(feed.entries[0]!)).toBeUndefined();
    expect(isPublication(feed.entries[1]!)).toBe(false);
    expect(navigationHref(feed.entries[1]!)).toBe("http://h/opds/sub");
  });

  test("refuses a document that isn't a feed", () => {
    expect(() => parseFeed("<html><body>login</body></html>", "http://h/", load)).toThrow(/not an OPDS catalog/);
  });
});

describe("search templates", () => {
  test("picks the Atom template from a description and fills it", () => {
    const template = templateFromDescription(
      `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
         <Url type="text/html" template="/web?q={searchTerms}"/>
         <Url type="application/atom+xml" template="/opds/search/{searchTerms}?p={startPage?}"/>
       </OpenSearchDescription>`,
      "http://h/opds/osd",
      load,
    );
    expect(template).toBe("http://h/opds/search/{searchTerms}?p={startPage?}");
    expect(fillSearchTemplate(template!, "one piece")).toBe("http://h/opds/search/one%20piece?p=");
  });
});
