import "server-only";

import createClient from "openapi-fetch";

import type { paths } from "@/generated/api";

/**
 * The quoters this BFF may call, from the environment:
 *
 * - `QUOTERS`: a JSON map of name → base URL, e.g.
 *   `{"go":"http://localhost:24791","python":"http://localhost:24792"}`;
 *   the first entry is the default;
 * - otherwise `QUOTER_URL`, a single quoter named `default`
 *   (`http://localhost:24791` when unset).
 *
 * The browser picks a quoter by name only, checked against this list: it can
 * never make the BFF call a URL of its choosing.
 */
export interface Quoter {
  name: string;
  url: string;
}

const DEFAULT_QUOTER_URL = "http://localhost:24791";

/** A little above the quoter's own `REQUEST_TIMEOUT` (30 s), so its answer wins the race. */
const DEFAULT_TIMEOUT_MS = 35_000;

export function configuredQuoters(): Quoter[] {
  const map = process.env.QUOTERS;
  if (!map) return [{ name: "default", url: checkedUrl("QUOTER_URL", process.env.QUOTER_URL || DEFAULT_QUOTER_URL) }];

  let parsed: unknown;
  try {
    parsed = JSON.parse(map);
  } catch {
    throw new Error("QUOTERS must be a JSON object of name → URL.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("QUOTERS must be a non-empty JSON object of name → URL.");
  }
  return Object.entries(parsed).map(([name, url]) => ({ name, url: checkedUrl(`QUOTERS.${name}`, url) }));
}

/** The quoter with this name, the default one when no name is given, or undefined if unknown. */
export function resolveQuoter(name?: string): Quoter | undefined {
  const quoters = configuredQuoters();
  return name === undefined ? quoters[0] : quoters.find((quoter) => quoter.name === name);
}

export function quoterClient(quoter: Quoter) {
  return createClient<paths>({ baseUrl: quoter.url });
}

export function quoterTimeoutMs(): number {
  const value = Number(process.env.QUOTER_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function checkedUrl(variable: string, value: unknown): string {
  if (typeof value === "string" && URL.canParse(value)) {
    const { protocol } = new URL(value);
    if (protocol === "http:" || protocol === "https:") return value;
  }
  throw new Error(`${variable} must be an http(s) URL, got ${JSON.stringify(value)}.`);
}
