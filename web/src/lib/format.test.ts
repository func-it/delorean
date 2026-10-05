import { describe, expect, it } from "vitest";

import { formatCents, formatCount, formatPercent } from "./format";

// French typography: a no-break space before €, %, $US; a narrow one between thousands and before units.
const NBSP = "\u00a0";
const NNBSP = "\u202f";

describe("formatCents", () => {
  it.each([
    [3600, `36,00${NBSP}€`],
    [2700, `27,00${NBSP}€`],
    [5, `0,05${NBSP}€`],
    [0, `0,00${NBSP}€`],
    [123456, `1${NNBSP}234,56${NBSP}€`],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });
});

describe("other formats", () => {
  it("formats a ratio as a whole percent", () => {
    expect(formatPercent(0.974)).toBe(`97${NBSP}%`);
  });

  it("groups thousands in a count", () => {
    expect(formatCount(3120)).toBe(`3${NNBSP}120`);
  });
});
