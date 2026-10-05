import type { NextConfig } from "next";

/**
 * What the page may load and do: its own origin, nothing else. Next writes a few inline scripts and
 * styles of its own, hence `unsafe-inline`; `unsafe-eval` only for `next dev`.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The headers of every answer. HSTS is the edge proxy's business too; sent here as well it costs nothing
 * (browsers ignore it over plain HTTP), and it names no subdomain.
 */
export function securityHeaders(development: boolean): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(development) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Strict-Transport-Security", value: "max-age=15552000" },
  ];
}

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into web/.
  agentRules: false,
  // Nobody needs to be told which framework answers.
  poweredByHeader: false,
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV !== "production") }]),
};

export default nextConfig;
