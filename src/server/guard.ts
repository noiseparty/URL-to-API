/**
 * The SSRF guard. This app fetches arbitrary URLs on behalf of strangers, from a box that
 * also runs Postgres, a dozen loopback services and a cloud metadata endpoint. Everything
 * the fetcher connects to must have passed through here first.
 *
 * Three layers, each assuming the one before it failed:
 *   1. checkUrl()     — syntax: scheme, port, credentials, obviously-internal hostnames.
 *   2. resolveHost()  — DNS: every address a name resolves to must be public unicast.
 *   3. isPublicAddress() is re-applied to the socket's actual remote address at connect
 *      time by the fetcher, and the connection is pinned to the vetted IP via a custom
 *      `lookup`, so a DNS answer that changes between check and connect (rebinding)
 *      cannot redirect the socket.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class GuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
/** URL() drops a port equal to the scheme default, so "" means 80 for http and 443 for https. */
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * Explicit blocklist, applied on top of ipaddr.js's own range() classification. Redundant
 * for most entries by design — if a library upgrade reclassifies a range, this still holds.
 */
const BLOCKED_CIDRS: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [
  // IPv4
  "0.0.0.0/8", // "this network", incl. 0.0.0.0 which Linux routes to loopback
  "10.0.0.0/8", // RFC 1918
  "100.64.0.0/10", // CGNAT (also Alibaba metadata at 100.100.100.200)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. 169.254.169.254 cloud metadata
  "172.16.0.0/12", // RFC 1918 (and Docker's bridge networks)
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16", // RFC 1918
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. 255.255.255.255 broadcast
  // IPv6
  "::/96", // unspecified, loopback, deprecated IPv4-compatible
  "::ffff:0:0/96", // IPv4-mapped (unwrapped and re-checked separately)
  "64:ff9b::/96", // NAT64 — would reach an embedded IPv4, possibly private
  "64:ff9b:1::/48", // local-use NAT64
  "100::/64", // discard-only
  "2001::/32", // Teredo — embeds an IPv4
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4 — embeds an IPv4
  "fc00::/7", // unique local (incl. fd00:ec2::254, AWS metadata over IPv6)
  "fe80::/10", // link-local
  "fec0::/10", // deprecated site-local
  "ff00::/8", // multicast
].map((c) => ipaddr.parseCIDR(c));

/** Names that are internal by convention and have no business being fetched. */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".localdomain",
  ".corp",
  ".private",
];

/**
 * True only for a globally routable unicast address. Anything ipaddr.js does not classify
 * as plain "unicast" is refused, and the explicit list above is checked regardless.
 */
export function isPublicAddress(address: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // Strict parse: only canonical dotted-quad or standard IPv6 text. Resolver output and
    // socket.remoteAddress are always in that form; anything else is suspicious.
    const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (!isIP(bare)) return false;
    addr = ipaddr.parse(bare);
  } catch {
    return false;
  }

  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      // ::ffff:127.0.0.1 — judge the IPv4 it carries.
      return isPublicAddress(v6.toIPv4Address().toString());
    }
  }

  if (addr.range() !== "unicast") return false;

  for (const [net, bits] of BLOCKED_CIDRS) {
    if (net.kind() === addr.kind() && addr.match(net, bits)) return false;
  }
  return true;
}

export interface CheckedUrl {
  url: URL;
  /** Hostname without IPv6 brackets. */
  host: string;
  /** Set when the host is already an IP literal (after URL() normalisation). */
  literalIp: string | null;
}

const MAX_URL_LENGTH = 2048;

/**
 * Layer 1: syntax. Accepts a bare "example.com" by assuming https.
 *
 * WHATWG URL parsing is what normalises the tricky IPv4 spellings — 2130706433,
 * 0177.0.0.1, 0x7f.1 and 127.1 all become "127.0.0.1" — so the literal check below sees
 * the canonical form and cannot be fooled by encoding.
 */
export function checkUrl(input: string): CheckedUrl {
  const raw = input.trim();
  if (!raw) throw new GuardError("empty", "Enter a web address to extract.");
  if (raw.length > MAX_URL_LENGTH) {
    throw new GuardError("too_long", `That address is longer than ${MAX_URL_LENGTH} characters.`);
  }

  // Only add a scheme when there plainly is none. "file:///etc/passwd" and "gopher://x"
  // must reach the protocol check as themselves, not become "https://file:///...".
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  const looksLikeHostPort = /^[^/:]+:\d+(\/|$)/.test(raw); // "example.com:8080/x"
  const candidate = hasScheme && !looksLikeHostPort ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new GuardError("invalid_url", "That doesn't look like a web address.");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new GuardError(
      "bad_scheme",
      `Only http:// and https:// pages can be fetched, not ${url.protocol}//.`,
    );
  }
  if (url.username || url.password) {
    throw new GuardError("credentials", "Addresses with a username or password in them are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new GuardError("bad_port", `Only the standard web ports (80 and 443) are allowed, not ${url.port}.`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) throw new GuardError("invalid_url", "That address has no host name.");

  if (isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new GuardError("private_address", "That address points into a private or reserved network.");
    }
    url.hash = "";
    return { url, host, literalIp: host };
  }

  if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, "") || host.endsWith(s))) {
    throw new GuardError("private_host", "That host name refers to a local or internal network.");
  }
  if (!host.includes(".")) {
    // Single-label names ("metadata", "postgres") only resolve via search domains or
    // /etc/hosts — i.e. only ever to something internal.
    throw new GuardError("private_host", "Use a full public host name, like example.com.");
  }

  url.hash = "";
  return { url, host, literalIp: null };
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (host) => {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * Layer 2: DNS. Every address the name resolves to must be public — not just the first.
 * A name that returns one public and one private record is refused outright, because the
 * OS resolver and the socket library do not promise to agree on which one gets used.
 * Returns the single address the connection will be pinned to (IPv4 preferred).
 */
export async function resolveHost(
  checked: CheckedUrl,
  resolver: Resolver = systemResolver,
): Promise<ResolvedAddress> {
  if (checked.literalIp) {
    return { address: checked.literalIp, family: isIP(checked.literalIp) === 6 ? 6 : 4 };
  }

  let records: ResolvedAddress[];
  try {
    records = await resolver(checked.host);
  } catch {
    throw new GuardError("dns_failed", `Couldn't find a server called ${checked.host}.`);
  }
  if (records.length === 0) {
    throw new GuardError("dns_failed", `Couldn't find a server called ${checked.host}.`);
  }
  for (const r of records) {
    if (!isPublicAddress(r.address)) {
      throw new GuardError(
        "private_address",
        `${checked.host} resolves to a private or reserved address (${r.address}), so it can't be fetched.`,
      );
    }
  }
  return records.find((r) => r.family === 4) ?? records[0]!;
}

/** Convenience for tests and the fetcher: layers 1 and 2 together. */
export async function vet(input: string, resolver?: Resolver) {
  const checked = checkUrl(input);
  const pinned = await resolveHost(checked, resolver);
  return { ...checked, pinned };
}
