import "server-only";

import createClient from "openapi-fetch";

import type { paths } from "@/generated/api";

/**
 * The quoter this BFF calls: `QUOTER_URL` (`http://localhost:24793` when unset), from the environment
 * only. The browser says nothing about where a request goes: it can never make the BFF call a URL of
 * its choosing.
 */
export interface Quoter {
  name: string;
  url: string;
}

const DEFAULT_QUOTER_URL = "http://localhost:24793";

/** A little above the quoter's own `REQUEST_TIMEOUT` (15 s), so its answer wins the race. */
const DEFAULT_TIMEOUT_MS = 20_000;

export function configuredQuoter(): Quoter {
  return { name: "quoter", url: checkedUrl("QUOTER_URL", process.env.QUOTER_URL || DEFAULT_QUOTER_URL) };
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
