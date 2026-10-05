import { describe, expect, it } from "vitest";

import { adviseSize, cartBytes, CHARACTERS_PER_TOKEN } from "./size";

const limits = { maxBodyBytes: 8192, maxInputTokens: 256 };
const approximateMax = limits.maxInputTokens * CHARACTERS_PER_TOKEN;

describe("cartBytes", () => {
  it("measures the body the quoters read: the JSON of the cart, escapes and UTF-8 included", () => {
    expect(cartBytes("")).toBe('{"cart":""}'.length);
    expect(cartBytes("é")).toBe('{"cart":"é"}'.length + 1);
    expect(cartBytes("a\nb")).toBe('{"cart":"a\\nb"}'.length);
    expect(cartBytes("😀")).toBe('{"cart":""}'.length + 4);
  });
});

describe("adviseSize", () => {
  it("says nothing of a cart far from the limits", () => {
    expect(adviseSize("Back to the Future 1\nLa chèvre", limits)).toEqual({ state: "ok" });
    expect(adviseSize("a".repeat(Math.floor(approximateMax * 0.7) - 1), limits)).toEqual({ state: "ok" });
  });

  it("shows the length from 70 % of the estimated limit, up to it", () => {
    const near = adviseSize("a".repeat(Math.ceil(approximateMax * 0.7)), limits);
    expect(near).toMatchObject({ state: "near", approximateMax });
    expect(adviseSize("a".repeat(approximateMax), limits).state).toBe("near");
  });

  it("warns, without refusing, over the estimated limit", () => {
    expect(adviseSize("a".repeat(approximateMax + 1), limits)).toMatchObject({ state: "long", characters: approximateMax + 1 });
  });

  it("counts characters, not bytes or UTF-16 units", () => {
    expect(adviseSize("😀".repeat(approximateMax), limits)).toMatchObject({ state: "near", characters: approximateMax });
  });

  it("refuses what the quoters would refuse for its bytes, exactly at their limit", () => {
    const fits = "a".repeat(8192 - cartBytes(""));
    expect(cartBytes(fits)).toBe(8192);
    expect(adviseSize(fits, limits).state).toBe("long");
    expect(adviseSize(fits + "a", limits)).toEqual({ state: "too_big", maxBodyBytes: 8192 });
  });
});
