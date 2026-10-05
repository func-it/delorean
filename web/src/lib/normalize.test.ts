import { describe, expect, it } from "vitest";

import { normalizeCart } from "./normalize";

describe("normalizeCart", () => {
  it.each([
    ["Back to the Future 1", "Back to the Future 1"],
    ["  Heat\r\n", "Heat"],
    ["a\r\nb\r\nc", "a\nb\nc"],
    ["Heat​2", "Heat2"], // a zero-width space splitting a word
    ["He⁠at", "Heat"], // word joiner
    ["‮Heat‬", "Heat"], // bidirectional override
    ["Heat\u{e0041}\u{e0042}", "Heat"], // tag characters, which spell ASCII no one sees
    ["﻿Heat", "Heat"], // a byte order mark
    ["Hea\u0007t", "Heat"], // a control character
    ["a\rb", "ab"], // a lone carriage return is one too
    ["a\tb\nc", "a\tb\nc"], // tab and line feed stay
    [" 　Heat ", "Heat"], // blanks of any kind at either end
    ["\u0085Heat", "Heat"],
    ["پیام‌ها", "پیام‌ها"], // the zero-width non-joiner stays: it is how Persian is spelt
    ["👨‍👩‍👧", "👨‍👩‍👧"], // and the joiner: it builds this
  ])("%j reads as %j", (text, expected) => {
    expect(normalizeCart(text)).toBe(expected);
  });

  it("puts composed and decomposed accents in one form, whatever sits between", () => {
    expect(normalizeCart("é")).toBe("é");
    expect(normalizeCart("e​́")).toBe("é");
  });

  it("makes two carts that differ only by what nobody sees the same text", () => {
    expect(normalizeCart("Back to the Future 1\r\n#x")).toBe(normalizeCart("Back​ to the Future 1\n#x "));
  });

  it("is idempotent", () => {
    const once = normalizeCart(" ‮A​́\r\n\tb ");
    expect(normalizeCart(once)).toBe(once);
  });
});
