import "server-only";

import createClient from "openapi-fetch";

import type { paths } from "@/generated/api";

/**
 * The backends this BFF may call, from the environment:
 *
 * - `BACKENDS`: a JSON map of name → base URL, e.g.
 *   `{"go":"http://localhost:24791","python":"http://localhost:24792"}`;
 *   the first entry is the default;
 * - otherwise `BACKEND_URL`, a single backend named `default`
 *   (`http://localhost:24791` when unset).
 *
 * The browser picks a backend by name only, checked against this list: it can
 * never make the BFF call a URL of its choosing.
 */
export interface Backend {
  name: string;
  url: string;
}

const DEFAULT_BACKEND_URL = "http://localhost:24791";

/** A little above the backend's own `REQUEST_TIMEOUT` (30 s), so its answer wins the race. */
const DEFAULT_TIMEOUT_MS = 35_000;

export function configuredBackends(): Backend[] {
  const map = process.env.BACKENDS;
  if (!map) return [{ name: "default", url: checkedUrl("BACKEND_URL", process.env.BACKEND_URL || DEFAULT_BACKEND_URL) }];

  let parsed: unknown;
  try {
    parsed = JSON.parse(map);
  } catch {
    throw new Error("BACKENDS must be a JSON object of name → URL.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("BACKENDS must be a non-empty JSON object of name → URL.");
  }
  return Object.entries(parsed).map(([name, url]) => ({ name, url: checkedUrl(`BACKENDS.${name}`, url) }));
}

/** The backend with this name, the default one when no name is given, or undefined if unknown. */
export function resolveBackend(name?: string): Backend | undefined {
  const backends = configuredBackends();
  return name === undefined ? backends[0] : backends.find((backend) => backend.name === name);
}

export function backendClient(backend: Backend) {
  return createClient<paths>({ baseUrl: backend.url });
}

export function backendTimeoutMs(): number {
  const value = Number(process.env.BACKEND_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function checkedUrl(variable: string, value: unknown): string {
  if (typeof value === "string" && URL.canParse(value)) {
    const { protocol } = new URL(value);
    if (protocol === "http:" || protocol === "https:") return value;
  }
  throw new Error(`${variable} must be an http(s) URL, got ${JSON.stringify(value)}.`);
}
