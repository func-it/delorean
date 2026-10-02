import { resolveBackend } from "@/lib/backends";
import { problemResponse, relay } from "@/lib/bff";
import { getSession } from "@/lib/session";

interface QuoteBody {
  cart: string;
  /** A configured backend name; the default backend when absent. */
  backend?: string;
}

/**
 * Prices a cart: forwards `{ cart }` to the backend's `POST /v1/quotes` with
 * the session identity, and relays the answer (a Quote, or a Problem the UI
 * explains).
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  const session = await getSession();
  if (!session) return problemResponse(401, "no_session", "Log in before pricing a cart.", requestId);

  const body = await readBody(request);
  if (!body) {
    return problemResponse(400, "malformed_request", 'Expected a JSON body {"cart": string, "backend"?: string}.', requestId);
  }

  const backend = resolveBackend(body.backend);
  if (!backend) return problemResponse(400, "malformed_request", `Unknown backend "${body.backend}".`, requestId);

  return relay(backend, requestId, (client, signal) =>
    client.POST("/v1/quotes", {
      body: { cart: body.cart },
      params: {
        header: { "X-User-Id": session.username, "X-Session-Id": session.sessionId, "X-Request-Id": requestId },
      },
      signal,
    }),
  );
}

async function readBody(request: Request): Promise<QuoteBody | null> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const { cart, backend } = body as Record<string, unknown>;
  if (typeof cart !== "string") return null;
  if (backend !== undefined && typeof backend !== "string") return null;
  return { cart, backend };
}
