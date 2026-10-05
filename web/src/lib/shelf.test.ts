import { describe, expect, it } from "vitest";

import { catalog } from "@/test/fixtures";

import { describePrices } from "./shelf";

describe("describePrices", () => {
  it("writes the footer from the quoter's catalog: the volume price, the other film, the saga tiers in order", () => {
    const text = describePrices(catalog)?.replace(/[\u00a0\u202f]/g, " ");

    expect(text).toBe(
      "Chaque volet de la saga : 15,00 € le DVD, tout autre film : 20,00 €. " +
        "Remise sur les DVD de la saga, selon les volets différents du panier : 2 volets différents : −10 %, 3 volets différents : −20 %.",
    );
  });

  it("follows the catalog when the prices change, with no figure of its own", () => {
    const changed = {
      ...catalog,
      other_film_unit_price_cents: 2500,
      films: catalog.films.map((film) => ({ ...film, unit_price_cents: 1200 })),
      saga_discounts: [{ distinct_volumes: 2, percent: 5 }],
    };

    expect(describePrices(changed)?.replace(/[\u00a0\u202f]/g, " ")).toBe(
      "Chaque volet de la saga : 12,00 € le DVD, tout autre film : 25,00 €. " +
        "Remise sur les DVD de la saga, selon les volets différents du panier : 2 volets différents : −5 %.",
    );
  });

  it("lists the volumes one by one when they do not cost the same, and says nothing of a tier that is not there", () => {
    const unequal = {
      ...catalog,
      films: catalog.films.map((film) => ({ ...film, unit_price_cents: film.volume === 3 ? 1800 : 1500 })),
      saga_discounts: [],
    };

    expect(describePrices(unequal)?.replace(/[\u00a0\u202f]/g, " ")).toBe(
      "Les volets de la saga : 1 : 15,00 €, 2 : 15,00 €, 3 : 18,00 €, tout autre film : 20,00 €.",
    );
  });

  it("writes nothing without a catalog, or with no film in it", () => {
    expect(describePrices(undefined)).toBeUndefined();
    expect(describePrices({ ...catalog, films: [] })).toBeUndefined();
  });
});
