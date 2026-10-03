import { scanValue, skipSpace } from './json.ts';

/**
 * Reads a QuoteRequest off a request body, strictly: at most the byte limit,
 * one JSON object, a `cart` string and no other field. What is wrong is said
 * in the contract's terms, for the 400 problem's detail.
 */

/** The body is over the limit: 413 payload_too_large. */
export class TooLarge extends Error {
  override name = 'TooLarge';
  readonly limit: number;

  constructor(limit: number) {
    super(`The body exceeds ${limit} bytes.`);
    this.limit = limit;
  }
}

/** The body is not a QuoteRequest: 400 malformed_request. */
export class Malformed extends Error {
  override name = 'Malformed';
}

/**
 * The body's bytes, refused as soon as they pass `limit`: a declared length
 * over it before a byte is read, a stream over it at the first chunk past it.
 */
export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new TooLarge(limit);
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // undici types a body's chunks as any; they are bytes
  for await (const chunk of request.body as ReadableStream<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new TooLarge(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The cart of a QuoteRequest body, its faults checked in the order every
 * quoter checks them (docs/architecture.md, "Identical quoters"): empty, not
 * UTF-8 (JSON is UTF-8, RFC 8259: an invalid byte is refused, never
 * repaired), truncated, invalid, data after the object, not an object, an
 * unknown field, no cart, a cart that is not a string. A byte order mark is
 * not JSON.
 */
export function decodeQuoteRequest(body: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    // never empty: an invalid byte is no whitespace
    throw new Malformed('body: not valid UTF-8');
  }
  const start = skipSpace(text, 0);
  if (start === text.length) throw new Malformed('body: empty, a QuoteRequest object is expected');
  const scan = scanValue(text, start);
  if ('error' in scan) throw new Malformed(scan.error === 'truncated' ? 'body: truncated JSON' : 'body: invalid JSON');
  if (skipSpace(text, scan.end) < text.length) {
    throw new Malformed('body: unexpected data after the QuoteRequest object');
  }
  const request = JSON.parse(text) as unknown;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Malformed(`body: a QuoteRequest object is expected, not a JSON ${jsonType(request)}`);
  }
  const unknown = Object.keys(request).find((key) => key !== 'cart');
  if (unknown !== undefined) throw new Malformed(`body: unknown field ${JSON.stringify(unknown)}`);
  if (!('cart' in request)) throw new Malformed('body: field "cart" is required');
  if (typeof request.cart !== 'string') {
    throw new Malformed(`body: field "cart" must be a string, not a JSON ${jsonType(request.cart)}`);
  }
  return request.cart;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}
