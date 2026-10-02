import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { postQuote, postRaw, send } from '../src/api.ts';
import { PRICED_CART, baseUrl, catalog, client, expectConforms, expectProblem, expectQuote } from './support.ts';

const { max_body_bytes: maxBodyBytes, max_input_tokens: maxInputTokens } = catalog.limits;

/** A QuoteRequest body of exactly `bytes` bytes, its cart made of words. */
function bodyOfBytes(bytes: number): string {
  const frame = JSON.stringify({ cart: '' }).length;
  return JSON.stringify({ cart: 'film '.repeat(bytes).slice(0, bytes - frame) });
}

describe('POST /v1/quotes: correlation', () => {
  it('echoes the X-Request-Id it receives', async () => {
    const id = `e2e-${randomUUID()}`;
    const exchange = await postQuote(client, PRICED_CART, {
      'X-Request-Id': id,
      'X-User-Id': 'marty.mcfly@hill-valley',
      'X-Session-Id': 'session:1985-10-26',
    });
    expectQuote(exchange);
    expect(exchange.response.headers.get('x-request-id')).toBe(id);
  });

  it('generates an X-Request-Id when the client sends none', async () => {
    const ids = await Promise.all(
      [1, 2].map(async () => {
        const exchange = await postQuote(client, PRICED_CART);
        expectQuote(exchange);
        return exchange.response.headers.get('x-request-id');
      }),
    );
    expect(
      ids.every((id) => id !== null && id.length > 0),
      `ids: ${JSON.stringify(ids)}`,
    ).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('echoes the X-Request-Id on a refusal too', async () => {
    const id = `e2e-${randomUUID()}`;
    const exchange = await postQuote(client, ' ', { 'X-Request-Id': id });
    expectProblem(exchange, 422, 'empty_cart');
    expect(exchange.response.headers.get('x-request-id')).toBe(id);
  });

  it('echoes the X-Request-Id on a malformed request', async () => {
    const id = `e2e-${randomUUID()}`;
    const exchange = await postRaw(baseUrl, '{}', { 'X-Request-Id': id });
    expectProblem(exchange, 400, 'malformed_request');
    expect(exchange.response.headers.get('x-request-id')).toBe(id);
  });
});

describe('POST /v1/quotes: malformed requests', () => {
  it.each(['marty mcfly', 'doc;brown', 'x'.repeat(65)])('rejects X-User-Id %j with 400', async (userId) => {
    expectProblem(await postQuote(client, PRICED_CART, { 'X-User-Id': userId }), 400, 'malformed_request');
  });

  it.each([
    ['a body that is not JSON', '{"cart": "Back to the Future 1"'],
    ['a body without cart', '{}'],
    ['a cart that is not a string', '{"cart": 1985}'],
    ['an unknown property', '{"cart": "Back to the Future 1", "discount_percent": 100}'],
  ])('rejects %s with 400 malformed_request', async (_, body) => {
    expectProblem(await postRaw(baseUrl, body), 400, 'malformed_request');
  });

  it('rejects a body over limits.max_body_bytes with 413', async () => {
    expectProblem(await postRaw(baseUrl, bodyOfBytes(maxBodyBytes + 1)), 413, 'payload_too_large');
  });

  it('reads a body of exactly limits.max_body_bytes', async () => {
    const exchange = await postRaw(baseUrl, bodyOfBytes(maxBodyBytes));
    expect(exchange.response.status).not.toBe(413);
    expectConforms(exchange);
  });
});

describe('POST /v1/quotes: prepare', () => {
  it.each(['', ' \n\t \n ', '\u0000\u0007\r\n'])('rejects the blank cart %j as empty_cart', async (cart) => {
    expectProblem(await postQuote(client, cart), 422, 'empty_cart');
  });

  it('rejects a cart over limits.max_input_tokens as too_long, before any model reads it', async () => {
    // Each word is at least one token, whatever the tokenizer.
    const cart = 'film '.repeat(2 * maxInputTokens);
    expect(cart.length, 'the cart must fit in the body limit').toBeLessThan(maxBodyBytes);

    const problem = expectProblem(await postQuote(client, cart), 422, 'too_long');
    expect(problem.tokens?.max).toBe(maxInputTokens);
    expect(problem.tokens?.count).toBeGreaterThan(maxInputTokens);
  });
});

describe('routing', () => {
  it('answers 404 not_found off the contract paths', async () => {
    expectProblem(await send(baseUrl, '/v1/films'), 404, 'not_found', { router: true });
  });

  it('answers 405 method_not_allowed to a method the path does not take', async () => {
    expectProblem(await send(baseUrl, '/v1/quotes'), 405, 'method_not_allowed', { router: true });
  });
});
