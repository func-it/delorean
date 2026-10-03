import type { NextRequest } from "next/server";

import { resolveQuoter } from "@/lib/quoters";
import { problemResponse, relay } from "@/lib/bff";
import { getSession } from "@/lib/session";

/** Prices and discounts change with a deployment, not between two requests. */
const REVALIDATE_SECONDS = 60;

/** The catalog of a quoter, picked by name with `?quoter=` (the default one otherwise). */
export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID();

  if (!(await getSession())) return problemResponse(401, "no_session", "Log in before reading the catalog.", requestId);

  const name = request.nextUrl.searchParams.get("quoter") ?? undefined;
  const quoter = resolveQuoter(name);
  if (!quoter) return problemResponse(400, "malformed_request", `Unknown quoter "${name}".`, requestId);

  return relay(quoter, requestId, (client, signal) =>
    client.GET("/v1/catalog", { next: { revalidate: REVALIDATE_SECONDS }, signal }),
  );
}
