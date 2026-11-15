/**
 * OPDS search, which a catalog advertises with a `rel="search"` link: either straight to a URL
 * template, or to an OpenSearch description document holding one.
 */
import type { OpdsFeed, XmlLoader } from "./feed.ts";

const restoreBraces = (url: string): string => url.replace(/%7B([\w:]+\??)%7D/gi, "{$1}");

function resolveTemplate(template: string, base: string): string {
  return restoreBraces(new URL(template, base).toString());
}

/** The OpenSearch description's best URL template: an Atom one, else any with `{searchTerms}`. */
export function templateFromDescription(xml: string, descriptionUrl: string, load: XmlLoader): string | undefined {
  const $ = load(xml);
  const urls = $("*")
    .toArray()
    .map((el) => el as unknown as { name: string; attribs: Record<string, string> })
    .filter((el) => el.name.replace(/^.*:/, "").toLowerCase() === "url" && el.attribs.template?.includes("{searchTerms}"));
  const atom = urls.find((u) => (u.attribs.type ?? "").toLowerCase().includes("atom+xml"));
  const pick = atom ?? urls[0];
  return pick ? resolveTemplate(pick.attribs.template!, descriptionUrl) : undefined;
}

/**
 * Where to search this catalog: a URL template with `{searchTerms}` in it, or undefined when the
 * catalog offers no search. `fetchText` is only called for an OpenSearch description.
 */
export async function findSearchTemplate(
  feed: OpdsFeed,
  fetchText: (url: string) => Promise<string>,
  load: XmlLoader,
): Promise<string | undefined> {
  const links = feed.links.filter((l) => l.rel === "search");
  const direct = links.find((l) => restoreBraces(l.href).includes("{searchTerms}"));
  if (direct) return restoreBraces(direct.href);
  const description = links.find((l) => (l.type ?? "").toLowerCase().includes("opensearchdescription"));
  if (!description) return undefined;
  return templateFromDescription(await fetchText(description.href), description.href, load);
}

/** Fill a template: the terms go in `{searchTerms}`, and every other parameter is left empty. */
export function fillSearchTemplate(template: string, terms: string): string {
  return template
    .replace(/\{searchTerms\??\}/g, encodeURIComponent(terms))
    .replace(/\{[\w:]+\??\}/g, "");
}
