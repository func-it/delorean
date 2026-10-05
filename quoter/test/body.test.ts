import { describe, expect, it } from 'vitest';
import { Malformed, decodeQuoteRequest } from '../src/http/body.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

// What the quoter reads of a request body, key by key (docs/architecture.md).
describe('decodeQuoteRequest', () => {
  it('takes the last of a duplicated cart', () => {
    expect(decodeQuoteRequest(bytes('{"cart":"first","cart":"Heat"}'))).toBe('Heat');
  });

  it.each([
    ['{"Cart":"x"}', 'Cart'],
    ['{"CART":"x"}', 'CART'],
    ['{"cart":"x","1":2,"b":3}', '1'],
    ['{"b":1,"1":2,"cart":"x"}', 'b'],
    ['{"2":1,"cart":"x","1":3}', '2'],
    ['{ "cart" : "x" , "k" : { "cart" : 1 } , "z" : [ "y" ] }', 'k'],
  ])('names the first key that is not exactly cart, in the order of the document: %s', (body, key) => {
    expect(() => decodeQuoteRequest(bytes(body))).toThrow(new Malformed(`body: unknown field ${JSON.stringify(key)}`));
  });

  it('does not take the keys of a nested object for its own', () => {
    expect(decodeQuoteRequest(bytes('{"cart":"x"}'))).toBe('x');
    expect(() => decodeQuoteRequest(bytes('{"cart":{"b":1}}'))).toThrow('field "cart" must be a string');
  });
});
