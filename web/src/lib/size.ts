/**
 * How big a cart is, for the page to say so before it is sent. The quoters hold a cart to a number of
 * bytes (the body `{"cart": …}`) and to a number of tokens; a browser cannot count tokens as they do, so
 * it counts characters, at about three to a token: enough to warn, never to refuse.
 */
export interface Limits {
  /** The most bytes of `{"cart": …}` the quoters read (their `MAX_BODY_BYTES`). */
  maxBodyBytes: number;
  /** The most tokens of a cart the quoters read (their `MAX_INPUT_TOKENS`). */
  maxInputTokens: number;
}

export const CHARACTERS_PER_TOKEN = 3;

/** From this share of the token limit (estimated), the page shows how long the cart is. */
const NEAR = 0.7;

export type SizeAdvice =
  | { state: "ok" }
  | { state: "near"; characters: number; approximateMax: number }
  | { state: "long"; characters: number; approximateMax: number }
  | { state: "too_big"; maxBodyBytes: number };

/** The bytes the quoter measures: the JSON body it would read for this cart. */
export function cartBytes(cart: string): number {
  return new TextEncoder().encode(JSON.stringify({ cart })).length;
}

export function adviseSize(cart: string, { maxBodyBytes, maxInputTokens }: Limits): SizeAdvice {
  if (cartBytes(cart) > maxBodyBytes) return { state: "too_big", maxBodyBytes };
  const characters = [...cart].length;
  const approximateMax = maxInputTokens * CHARACTERS_PER_TOKEN;
  if (characters > approximateMax) return { state: "long", characters, approximateMax };
  if (characters >= approximateMax * NEAR) return { state: "near", characters, approximateMax };
  return { state: "ok" };
}
