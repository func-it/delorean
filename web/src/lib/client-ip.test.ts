import { describe, expect, it, vi } from "vitest";

import { clientIp } from "./client-ip";

const forwardedFor = (...values: string[]) => {
  const headers = new Headers();
  for (const value of values) headers.append("X-Forwarded-For", value);
  return headers;
};

describe("clientIp", () => {
  it("takes the connection's address, as Next writes it, without a proxy", () => {
    expect(clientIp(forwardedFor("203.0.113.7"))).toBe("203.0.113.7");
  });

  it("knows no address when there is no header", () => {
    expect(clientIp(new Headers())).toBeUndefined();
  });

  it("takes the entry our proxy appended, never the ones the client wrote", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "1");

    expect(clientIp(forwardedFor("198.51.100.1, 10.0.0.1", "203.0.113.7"))).toBe("203.0.113.7");
  });

  it("counts the proxies from the right", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "2");

    expect(clientIp(forwardedFor("198.51.100.1, 203.0.113.7, 10.0.0.2"))).toBe("203.0.113.7");
  });

  it("takes the farthest address known when the request skipped a proxy", () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "2");

    expect(clientIp(forwardedFor("203.0.113.7"))).toBe("203.0.113.7");
  });

  it.each([
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3:8d3::/64"],
    ["2001:DB8:85A3:08D3::1", "2001:db8:85a3:8d3::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["[2001:db8:0:1::a]:443", "2001:db8:0:1::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
  ])("keys an IPv6 client on its /64: %s", (address, key) => {
    expect(clientIp(forwardedFor(address))).toBe(key);
  });

  it("keeps two /64s apart, and two IPv4 addresses", () => {
    expect(clientIp(forwardedFor("2001:db8:0:1::a"))).not.toBe(clientIp(forwardedFor("2001:db8:0:2::a")));
    expect(clientIp(forwardedFor("203.0.113.7"))).not.toBe(clientIp(forwardedFor("203.0.113.8")));
  });

  it.each([
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:cb00:7107", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
  ])("keys an IPv4 client on its whole address: %s", (address, key) => {
    expect(clientIp(forwardedFor(address))).toBe(key);
  });

  it("keeps what is not an address as written", () => {
    expect(clientIp(forwardedFor("unknown"))).toBe("unknown");
  });

  it.each(["-1", "1.5", "true"])("refuses TRUST_PROXY_HOPS=%s", (value) => {
    vi.stubEnv("TRUST_PROXY_HOPS", value);

    expect(() => clientIp(forwardedFor("203.0.113.7"))).toThrow(/TRUST_PROXY_HOPS/);
  });
});
