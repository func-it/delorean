import "server-only";

/**
 * The limits of a cart, one figure from the browser to the quoter: the quoters' own `MAX_BODY_BYTES`
 * (the body `{"cart": …}` they read) and `MAX_INPUT_TOKENS`, which compose gives to all of them. The page
 * is told them, the BFF holds the request to them, the quoter has the last word.
 */
export function maxBodyBytes(): number {
  return positiveInteger("MAX_BODY_BYTES", 8192);
}

export function maxInputTokens(): number {
  return positiveInteger("MAX_INPUT_TOKENS", 256);
}

function positiveInteger(variable: string, fallback: number): number {
  const value = Number(process.env[variable]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
