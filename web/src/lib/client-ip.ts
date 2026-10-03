import "server-only";

import { isIPv4, isIPv6 } from "node:net";

/**
 * The client's address, one of the keys of the strike rule (see strikes.ts).
 * A route handler never sees the socket; it reads `X-Forwarded-For`, and
 * trusts only the entries our own side wrote:
 *
 * - `TRUST_PROXY_HOPS=N`, N ≥ 1: the BFF sits behind N proxies of ours, each
 *   of which appends the address it was connected from. The client is the
 *   N-th entry from the right; the entries left of it came with the request,
 *   and anyone can write them. The model holds only if the BFF cannot be
 *   reached without going through those proxies.
 * - `TRUST_PROXY_HOPS=0`, the default: no proxy. Next writes the connection's
 *   address into the header when the request has none, and that is the one
 *   used. Next keeps a header the client sent, though: without a proxy, a
 *   client that forges it chooses its address key. Exposed to the internet,
 *   the BFF goes behind a proxy that appends, with `TRUST_PROXY_HOPS` set.
 *
 * The key is the address as `addressKey` writes it: an IPv4 address whole, an
 * IPv6 one by its /64, the block a single subscriber holds.
 */
export function clientIp(headers: Headers): string | undefined {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  // Fewer entries than proxies: the request skipped one; the farthest address known is the left-most.
  return addressKey(entries[Math.max(0, entries.length - Math.max(trustedProxyHops(), 1))]);
}

/**
 * An IPv4 address as is; an IPv4-mapped IPv6 one (`::ffff:a.b.c.d`) as the
 * IPv4 it carries; any other IPv6 as its /64 prefix, e.g. `2001:db8:0:1::/64`.
 * A port or brackets around the address are dropped; what is not an address
 * is kept as written.
 */
function addressKey(entry: string): string {
  const address = entry
    .replace(/^\[([^\]]*)\](?::\d+)?$/, "$1")
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1")
    .replace(/%.*$/, "");
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return entry;
  const groups = hextets(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, `::` expanded, a trailing IPv4 as two groups. */
function hextets(address: string): number[] {
  const text = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    [(Number(a) << 8) | Number(b), (Number(c) << 8) | Number(d)].map((group) => group.toString(16)).join(":"),
  );
  const [head, tail] = text.split("::");
  const groups = (part?: string) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  if (tail === undefined) return groups(head);
  const [left, right] = [groups(head), groups(tail)];
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** A security setting: a value that does not parse fails loudly instead of falling back. */
function trustedProxyHops(): number {
  const value = process.env.TRUST_PROXY_HOPS;
  if (!value) return 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be a number of proxies (0 or more), got ${JSON.stringify(value)}.`);
  }
  return hops;
}
