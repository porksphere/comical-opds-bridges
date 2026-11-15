/**
 * A fake LANraragi, served in-process, with the shapes a live LANraragi 0.9.82 answers with
 * (captured from one). It pages search results at its `archives_per_page`, keeps reading progress
 * and the "new" flag, and checks the API key (`Authorization: Bearer <base64 key>`) where
 * LANraragi does: always for /api/shinobu and clearing "new", for progress when it protects it,
 * and for everything in No-Fun Mode.
 */
import type { HttpRequest, HttpResponse } from "@comical/sdk";

export const KEY = "lrr-test-key";
export const PER_PAGE = 10;
export const ARC = (n: number): string => n.toString(16).padStart(40, "0");

interface Archive {
  arcid: string;
  title: string;
  tags: string;
  summary: string;
  pagecount: number;
  progress: number;
  isnew: boolean;
  lastreadtime: number;
  added: number;
}

export interface LanraragiOptions {
  nofun?: boolean;
  authenticatedProgress?: boolean;
}

export function lanraragiServer(origin = "http://lrr.lan:3000", opts: LanraragiOptions = {}) {
  const requests: HttpRequest[] = [];
  const archives: Archive[] = [
    {
      arcid: ARC(1),
      title: "Test Doujin",
      tags: "artist:jane doe, artist:ann, group:circle a, parody:original, character:alice, female:glasses, language:english, misc, date_added:1794719418, source:example.com/g/1",
      summary: " A summary. ",
      pagecount: 5,
      progress: 0,
      isnew: true,
      lastreadtime: 0,
      added: 3,
    },
    { arcid: ARC(2), title: "Started Book", tags: "group:circle b", summary: "", pagecount: 8, progress: 3, isnew: false, lastreadtime: 200, added: 2 },
    { arcid: ARC(3), title: "Finished Book", tags: "", summary: "", pagecount: 4, progress: 4, isnew: false, lastreadtime: 100, added: 1 },
    ...Array.from({ length: 12 }, (_, i) => ({
      arcid: ARC(100 + i),
      title: `Filler ${String(i).padStart(2, "0")}`,
      tags: "",
      summary: "",
      pagecount: 2,
      progress: 0,
      isnew: false,
      lastreadtime: 0,
      added: 0,
    })),
  ];
  const categories = [
    { id: "SET_1", name: "🔖 Favorites", archives: [] as string[], search: "", pinned: "0" },
    { id: "SET_2", name: "Best", archives: [ARC(2), ARC(1)], search: "", pinned: "0" },
    { id: "SET_3", name: "Dynamic", archives: [] as string[], search: "Book", pinned: "1" },
  ];
  const keyed = (req: HttpRequest) => req.headers?.Authorization === `Bearer ${btoa(KEY)}`;

  const reply = (status: number, body: unknown, type = "application/json"): HttpResponse => ({
    url: "",
    status,
    statusText: String(status),
    headers: { "content-type": type },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const unauthorized = () => reply(401, { errors: [{ message: "Unauthorized", path: "/security/0/api_key" }], status: 401 });
  const dto = (a: Archive) => ({
    arcid: a.arcid,
    extension: "cbz",
    filename: a.title,
    isnew: a.isnew,
    lastreadtime: a.lastreadtime,
    pagecount: a.pagecount,
    progress: a.progress,
    size: 1000,
    summary: a.summary,
    tags: a.tags,
    title: a.title,
    toc: [],
  });

  function route(req: HttpRequest, url: URL): HttpResponse {
    const p = url.pathname;
    const method = req.method ?? "GET";
    const q = (k: string) => url.searchParams.get(k);
    let m: RegExpExecArray | null;

    if (p === "/api/info") {
      return reply(200, {
        name: "LANraragi",
        version: "0.9.82",
        nofun_mode: opts.nofun ?? false,
        has_password: true,
        server_tracks_progress: true,
        authenticated_progress: opts.authenticatedProgress ?? false,
        archives_per_page: PER_PAGE,
        total_archives: archives.length,
      });
    }
    if (p === "/api/shinobu") return keyed(req) ? reply(200, { is_alive: 1, success: 1 }) : unauthorized();
    if (p === "/api/categories") return reply(200, categories);
    if (p === "/api/search") {
      let found = [...archives];
      const filter = (q("filter") ?? "").toLowerCase();
      if (filter) found = found.filter((a) => a.title.toLowerCase().includes(filter) || a.tags.toLowerCase().split(", ").includes(filter));
      if (q("newonly") === "true") found = found.filter((a) => a.isnew);
      const category = categories.find((c) => c.id === q("category"));
      if (category) found = category.search ? found.filter((a) => a.title.includes(category.search)) : found.filter((a) => category.archives.includes(a.arcid));
      const key = q("sortby") === "lastread" ? "lastreadtime" : q("sortby") === "date_added" ? "added" : "title";
      found.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
      if (q("order") === "desc") found.reverse();
      const start = Number(q("start") ?? 0);
      return reply(200, { data: found.slice(start, start + PER_PAGE).map(dto), recordsFiltered: found.length, recordsTotal: archives.length });
    }
    if ((m = /^\/api\/archives\/([0-9a-f]+)\/(metadata|files|thumbnail|page|progress\/(\d+)|isnew)$/.exec(p))) {
      const a = archives.find((x) => x.arcid === m![1]);
      const what = m[2]!;
      if (!a) {
        return what === "files"
          ? reply(500, { errors: [{ message: "Expected string - got Mojo::Exception." }], status: 500 })
          : reply(400, { error: "This ID doesn&#39;t exist on the server.", success: 0 });
      }
      if (what === "metadata") return reply(200, dto(a));
      if (what === "files") return reply(200, { pages: Array.from({ length: a.pagecount }, (_, i) => `/api/archives/${a.arcid}/page?path=${String(i).padStart(3, "0")}.jpg`) });
      if (what === "thumbnail" || what === "page") return reply(200, "jpeg", 'application/x-download;name="x.jpg"');
      if (what === "isnew" && method === "DELETE") {
        if (!keyed(req)) return unauthorized();
        a.isnew = false;
        return reply(200, { success: 1 });
      }
      if (what.startsWith("progress/") && method === "PUT") {
        if (opts.authenticatedProgress && !keyed(req)) return unauthorized();
        const page = Number(m[3]);
        if (page < 1 && q("force") !== "1") return reply(400, { error: "Invalid progress value.", success: 0 });
        a.progress = page;
        a.lastreadtime = 999;
        return reply(200, { page, success: 1 });
      }
    }
    return reply(404, { error: "not found" });
  }

  const handle = (req: HttpRequest): HttpResponse => {
    requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== origin) return reply(502, { error: "wrong origin" });
    if (opts.nofun && !keyed(req)) return { ...unauthorized(), url: req.url };
    return { ...route(req, url), url: req.url };
  };
  return { handle, requests, archives };
}
