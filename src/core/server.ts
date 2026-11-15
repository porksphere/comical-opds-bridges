/**
 * Plumbing every self-hosted bridge needs: the user's server address, its credentials, and the
 * image declaration that lets the host fetch covers and pages from that server with them.
 */
import type { BridgeInfo, ImageRequest } from "@comical/sdk";

/**
 * Tidy what a user typed into an absolute URL: trims it, assumes `http://` when no scheme is given
 * (a bare `192.168.1.5:25600` is how people write a LAN address), and drops trailing slashes.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`server address must be http:// or https://, not ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, "");
}

/** The hostname of an absolute URL, lowercased and without IPv6 brackets. */
export function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/** An HTTP Basic `Authorization` value, UTF-8 safe. */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/**
 * The `images` declaration for a bridge whose covers and pages live on the user's own server.
 *
 * Authenticated servers go through `intercept` rather than `images.headers`: `BridgeInfo` is handed
 * to every client (the bridge list), so a header declared there would publish the user's
 * credentials. An interceptor's headers are added at fetch time and never stored or serialized.
 * Without credentials the host has nothing to add, so clients load the server's images directly.
 */
export function serverImages(serverUrl: string | undefined, authenticated: boolean): BridgeInfo["images"] {
  if (!serverUrl) return undefined;
  const host = hostnameOf(serverUrl);
  return authenticated ? { hosts: [host], intercept: [host] } : { hosts: [host] };
}

/** The interceptor's answer for one image: the same URL, with the server's auth header if any. */
export function authorizedImage(url: string, authorization: string | undefined): ImageRequest {
  return authorization ? { url, headers: { Authorization: authorization } } : { url };
}
