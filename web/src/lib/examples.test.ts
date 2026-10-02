import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXAMPLES } from "./examples";

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
