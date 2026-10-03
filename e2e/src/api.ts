import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi.ts';
import type { Health } from './contract.ts';

export type Api = ReturnType<typeof api>;

export type QuoteHeaders = NonNullable<paths['/v1/quotes']['post']['parameters']['header']>;

export function api(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

/** One answer of the API: its body is the quote or the problem, as received. */
export interface Exchange {
  response: Response;
  body: unknown;
}

export async function postQuote(
  client: Api,
  cart: string,
  header: QuoteHeaders = {},
  signal?: AbortSignal,
): Promise<Exchange> {
  const { data, error, response } = await client.POST('/v1/quotes', {
    body: { cart },
    params: { header },
    ...(signal && { signal }),
  });
  return { response, body: data ?? error };
}

/** Posts a body as is, for the requests a typed client refuses to build: bytes go out untouched. */
export function postRaw(
  baseUrl: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Promise<Exchange> {
  return send(baseUrl, '/v1/quotes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/** Any request, off the contract's paths and methods included. */
export async function send(baseUrl: string, path: string, init: RequestInit = {}): Promise<Exchange> {
  const response = await fetch(new URL(path, baseUrl), init);
  return { response, body: await response.json() };
}

export async function fetchHealth(baseUrl: string): Promise<Health> {
  let result;
  try {
    result = await api(baseUrl).GET('/healthz');
  } catch (cause) {
    throw new Error(`No quoter answers at ${baseUrl}: start one (ENGINES=fake) or set BASE_URL.`, { cause });
  }
  if (!result.data) throw new Error(`GET ${baseUrl}/healthz answered ${result.response.status}`);
  return result.data;
}
