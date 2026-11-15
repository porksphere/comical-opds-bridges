/**
 * A Komga-shaped OPDS 1.2 catalog, served in-process. Shapes follow the OPDS 1.2 and OPDS-PSE 1.2
 * specs: navigation and acquisition feeds, `rel="next"` paging, an OpenSearch description, books
 * with a PSE stream (and one with only a download). Books carry what a live Komga 26.04 sends: one
 * author per role, and an untyped description of escaped HTML that opens with the file's size.
 */
import type { HttpRequest, HttpResponse } from "@comical/sdk";

const NS =
  'xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns" ' +
  'xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dcterms="http://purl.org/dc/terms/"';
const NAV = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition";

const feed = (id: string, title: string, body: string, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<feed ${NS}><id>${id}</id><title>${title}</title>` +
  `<updated>2026-11-14T00:00:00Z</updated>${extra}${body}</feed>`;

const nav = (title: string, href: string, type = NAV, thumb?: string) =>
  `<entry><title>${title}</title><id>${href}</id><updated>2026-11-14T00:00:00Z</updated>` +
  `<link rel="subsection" href="${href}" type="${type}"/>` +
  (thumb ? `<link rel="http://opds-spec.org/image/thumbnail" href="${thumb}" type="image/jpeg"/>` : "") +
  `</entry>`;

const book = (n: number, title: string, pages: number | undefined) =>
  `<entry><title>${title}</title><id>book-${n}</id><updated>2026-11-14T00:00:00Z</updated>` +
  `<author><name>Jane Artist</name></author><author><name>Jane Artist</name></author>` +
  `<content>cbz - 1.2 MiB&lt;br/>&lt;br/>Volume ${n} &amp;amp; more&lt;br/>Second line</content>` +
  `<dcterms:issued>2024-05-0${n}</dcterms:issued>` +
  `<link rel="http://opds-spec.org/image" href="/opds/v1.2/books/${n}/thumbnail" type="image/jpeg"/>` +
  `<link rel="http://opds-spec.org/image/thumbnail" href="/opds/v1.2/books/${n}/thumbnail/small" type="image/jpeg"/>` +
  `<link rel="http://opds-spec.org/acquisition" href="/opds/v1.2/books/${n}/file/book.cbz" type="application/zip"/>` +
  (pages
    ? `<link rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" ` +
      `href="/opds/v1.2/books/${n}/pages/{pageNumber}?zero_based=true" pse:count="${pages}" pse:lastRead="0"/>`
    : "") +
  `</entry>`;

const next = (href: string) => `<link rel="next" href="${href}" type="${ACQ}"/>`;

export const ROUTES: Record<string, string> = {
  "/opds/v1.2/catalog": feed(
    "root",
    "Komga OPDS catalog",
    nav("Keep reading", "/opds/v1.2/books/ondeck", ACQ) +
      nav("On Deck", "/opds/v1.2/ondeck", ACQ) +
      nav("Latest series", "/opds/v1.2/series/latest") +
      nav("Libraries", "/opds/v1.2/libraries") +
      nav("Broken", "/opds/v1.2/broken"),
    '<link rel="search" href="/opds/v1.2/search" type="application/opensearchdescription+xml"/>',
  ),
  // Empty until the reader starts something, so it can't be told apart yet.
  "/opds/v1.2/ondeck": feed("ondeck-empty", "On Deck", ""),
  "/opds/v1.2/books/ondeck": feed("ondeck", "Keep reading", book(1, "Test Series A v01", 4)),
  "/opds/v1.2/series/latest": feed(
    "latest",
    "Latest series",
    nav("Test Series A", "/opds/v1.2/series/a", ACQ, "/opds/v1.2/series/a/thumbnail") +
      nav("Test Series B", "/opds/v1.2/series/b", ACQ),
  ),
  "/opds/v1.2/libraries": feed(
    "libraries",
    "Libraries",
    nav("Manga", "/opds/v1.2/libraries/1") + nav("Comics", "/opds/v1.2/libraries/2"),
  ),
  "/opds/v1.2/libraries/1": feed(
    "lib1",
    "Manga",
    nav("Test Series A", "/opds/v1.2/series/a", ACQ, "/opds/v1.2/series/a/thumbnail"),
    next("/opds/v1.2/libraries/1?page=1"),
  ),
  "/opds/v1.2/libraries/1?page=1": feed("lib1p1", "Manga", nav("Test Series B", "/opds/v1.2/series/b", ACQ)),
  "/opds/v1.2/libraries/2": feed("lib2", "Comics", nav("Lone Oneshot", "/opds/v1.2/series/c", ACQ)),
  "/opds/v1.2/series/a": feed(
    "series-a",
    "Test Series A",
    book(1, "Test Series A v01", 4) + book(2, "Test Series A v02", 3),
    next("/opds/v1.2/series/a?page=1"),
  ),
  "/opds/v1.2/series/a?page=1": feed(
    "series-a-p1",
    "Test Series A",
    book(3, "Test Series A v03", 5) + book(4, "Test Series A extras", undefined),
  ),
  "/opds/v1.2/series/b": feed("series-b", "Test Series B", book(5, "Test Series B v01", 2)),
  "/opds/v1.2/search":
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Search</ShortName>' +
    `<Url type="${ACQ}" template="/opds/v1.2/series?search={searchTerms}&amp;page={startPage?}"/>` +
    "</OpenSearchDescription>",
  "/opds/v1.2/series?search=series%20a&page=": feed(
    "search",
    "Search results",
    nav("Test Series A", "/opds/v1.2/series/a", ACQ, "/opds/v1.2/series/a/thumbnail"),
  ),
};

export interface FixtureServer {
  handle: (req: HttpRequest) => HttpResponse;
  requests: HttpRequest[];
}

/**
 * Serves ROUTES on `origin`. With `auth`, answers 401 to any request whose Authorization header
 * isn't exactly it.
 */
export function opdsServer(origin = "http://komga.lan:25600", auth?: string): FixtureServer {
  const requests: HttpRequest[] = [];
  const handle = (req: HttpRequest): HttpResponse => {
    requests.push(req);
    const url = new URL(req.url);
    const reply = (status: number, body: string): HttpResponse => ({
      url: req.url,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { "content-type": "application/atom+xml" },
      body,
    });
    if (url.origin !== origin) return reply(404, "wrong host");
    if (auth && req.headers?.Authorization !== auth) return reply(401, "unauthorized");
    const body = ROUTES[`${url.pathname}${url.search}`];
    if (url.pathname === "/opds/v1.2/broken") return reply(500, "boom");
    return body ? reply(200, body) : reply(404, `no fixture for ${url.pathname}${url.search}`);
  };
  return { handle, requests };
}
