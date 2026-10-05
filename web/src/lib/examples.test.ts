import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXAMPLES, examplesFor } from "./examples";

const CASES = new URL("../../../cases/quote/", import.meta.url);

describe("example carts", () => {
  it.each(EXAMPLES.filter((example) => example.id.startsWith("enonce-")))(
    "$id is the cart of the shared case",
    async ({ id, cart }) => {
      const shared = JSON.parse(await readFile(new URL(`${id}.json`, CASES), "utf8"));
      expect(cart).toBe(shared.input.cart);
    },
  );
});

describe("examplesFor", () => {
  it("offers on fake engines only the examples the fake reads, and all of them otherwise", () => {
    expect(examplesFor("fake").map((example) => example.id)).toEqual(["enonce-1", "enonce-5"]);
    expect(examplesFor("live")).toEqual(EXAMPLES);
    expect(examplesFor(undefined)).toEqual(EXAMPLES);
  });

  it("flags as readable by the fake only what the shared cases for the fake price", () => {
    for (const example of EXAMPLES.filter((e) => e.fake)) expect(example.id).toMatch(/^enonce-/);
  });
});
