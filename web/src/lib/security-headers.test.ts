import { describe, expect, it } from "vitest";

import nextConfig, { contentSecurityPolicy, securityHeaders } from "../../next.config";

describe("the security headers", () => {
  it("send every answer the same set, and name no framework", async () => {
    const [rule] = (await nextConfig.headers?.()) ?? [];
    expect(rule?.source).toBe("/:path*");
    expect(Object.fromEntries(rule?.headers.map(({ key, value }) => [key, value]) ?? [])).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": "max-age=15552000",
    });
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("allow the page its own origin, no frame, no plugin, and eval only in development", () => {
    const production = contentSecurityPolicy(false);
    expect(production).toContain("default-src 'self'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(production).toContain("object-src 'none'");
    expect(production).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });

  it("does not make HSTS reach subdomains", () => {
    const value = securityHeaders(false).find(({ key }) => key === "Strict-Transport-Security")?.value;
    expect(value).not.toMatch(/includeSubDomains|preload/);
  });
});
