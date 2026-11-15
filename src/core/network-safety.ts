/**
 * Whether a user's credentials would cross an untrusted network unencrypted.
 *
 * The app allows plain HTTP everywhere (servers are user-supplied, so no per-host exception can
 * exist), which makes warning about the risky case each bridge's job, in its settings form. HTTP is
 * only worth a warning off the user's own networks: on a LAN, a single-label name, or Tailscale
 * (whose WireGuard tunnel already encrypts the traffic) it is the normal way to reach a home server.
 */
import { hostnameOf } from "./server.ts";

function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

/** True for hosts on networks the user controls or that encrypt on their own. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (h.endsWith(".ts.net")) return true;

  const v4 = ipv4(h);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // RFC 6598 shared space: Tailscale's addresses
    );
  }
  if (h.includes(":")) {
    return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  // A single-label name ("nas", "komga") only resolves on a local network.
  return !h.includes(".");
}

/**
 * The warning to show under a server's sign-in settings, or undefined when there is nothing to warn
 * about: no credentials, HTTPS, or a private host.
 */
export function insecureCredentialsWarning(serverUrl: string | undefined, hasCredentials: boolean): string | undefined {
  if (!serverUrl || !hasCredentials) return undefined;
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isPrivateHost(hostnameOf(serverUrl))) return undefined;
  return (
    "This server is reached over plain http:// outside your local network, so your username and " +
    "password are sent unencrypted. Use an https:// address, or reach the server over your home " +
    "network or Tailscale."
  );
}
