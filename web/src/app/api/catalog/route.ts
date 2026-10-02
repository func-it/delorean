import type { NextRequest } from "next/server";

import { resolveBackend } from "@/lib/backends";
import { problemResponse, relay } from "@/lib/bff";
import { getSession } from "@/lib/session";

/** Prices and discounts change with a deployment, not between two requests. */
const REVALIDATE_SECONDS = 60;

/** The catalog of a backend, picked by name with `?backend=` (the default one otherwise). */
export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID();

  if (!(await getSession())) return problemResponse(401, "no_session", "Log in before reading the catalog.", requestId);

  const name = request.nextUrl.searchParams.get("backend") ?? undefined;
  const backend = resolveBackend(name);
  if (!backend) return problemResponse(400, "malformed_request", `Unknown backend "${name}".`, requestId);

  return relay(backend, requestId, (client, signal) =>
    client.GET("/v1/catalog", { next: { revalidate: REVALIDATE_SECONDS }, signal }),
  );
}
