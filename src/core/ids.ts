/**
 * Opaque, URL-safe ids that carry a small JSON payload, tagged with a one-letter kind.
 *
 * Bridges for servers addressed by URL (OPDS above all) have no numeric ids to hand out, so an id
 * names what to fetch. Payload URLs are stored relative to the server's origin, so a user who moves
 * from a LAN address to an https:// one keeps every library entry and its progress.
 */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeId(kind: string, payload: unknown): string {
  return `${kind}.${toBase64Url(JSON.stringify(payload))}`;
}

/** The payload of an id of `kind`; throws a readable error for anything else. */
export function decodeId<T>(kind: string, id: string): T {
  const prefix = `${kind}.`;
  if (!id.startsWith(prefix)) throw new Error(`not a ${kind} id: ${id}`);
  try {
    return JSON.parse(fromBase64Url(id.slice(prefix.length))) as T;
  } catch {
    throw new Error(`malformed ${kind} id: ${id}`);
  }
}

export function idKind(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? "" : id.slice(0, dot);
}

/** `url` relative to `serverUrl`'s origin when it is on that origin, else unchanged. */
export function relativeToOrigin(url: string, serverUrl: string): string {
  const u = new URL(url);
  return u.origin === new URL(serverUrl).origin ? `${u.pathname}${u.search}` : url;
}

/** The inverse of {@link relativeToOrigin}. */
export function absoluteFromOrigin(ref: string, serverUrl: string): string {
  return new URL(ref, new URL(serverUrl).origin).toString();
}
