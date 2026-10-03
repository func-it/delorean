import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Quote } from "@/lib/contract";
import { catalog, quote } from "@/test/fixtures";

import { QuoteResult } from "./QuoteResult";

/** Intl puts no-break spaces in amounts: compare text with plain spaces. */
const text = (element: HTMLElement) => element.textContent!.replace(/[\u00a0\u202f]/g, " ");

describe("QuoteResult", () => {
  it("lists every line: the title as written, the film it was read as, quantity and prices", () => {
    render(<QuoteResult quote={quote} catalog={catalog} />);

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // Header, four lines, subtotal, discount.
    expect(rows).toHaveLength(7);
    expect(text(rows[2])).toContain("« BTTF 2 »");
    expect(text(rows[2])).toContain("Lu comme Retour vers le futur II, confiance 95 %");
    expect(text(rows[4])).toContain("« La chèvre »");
    expect(text(rows[4])).toContain("Lu comme Autre film");
    expect(within(rows[4]).getAllByRole("cell").map(text)).toEqual(["1", "20,00 €", "20,00 €"]);
  });

  it("flags only the doubtful identifications", () => {
    render(<QuoteResult quote={quote} catalog={catalog} />);

    const flagged = screen.getAllByText("à vérifier");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].closest("tr")).toHaveTextContent("La chèvre");
  });

  it("shows the saga discount and the total", () => {
    render(<QuoteResult quote={quote} catalog={catalog} />);

    const discount = screen.getByRole("rowheader", { name: /Remise sur la saga/ }).closest("tr")!;
    expect(text(discount)).toContain("3 volets différents : 20 % sur 45,00 € de DVD de la saga.");
    expect(text(discount)).toContain("−9,00 €");
    expect(text(screen.getByText("Total à payer").nextElementSibling as HTMLElement)).toBe("56,00 €");
  });

  it("says why there is no discount", () => {
    const single: Quote = {
      ...quote,
      discount: { distinct_volumes: 1, percent: 0, base_cents: 1500, amount_cents: 0 },
    };
    render(<QuoteResult quote={single} catalog={catalog} />);

    expect(screen.getByText(/la remise commence à deux volets différents/)).toBeInTheDocument();
  });

  it("explains the price with the judge's checks, on demand", async () => {
    render(<QuoteResult quote={quote} catalog={catalog} />);
    const why = screen.getByText("Pourquoi ce prix ?");
    expect(why.closest("details")).not.toHaveAttribute("open");

    await userEvent.click(why);

    const details = why.closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(text(details)).toContain("91 %, pour un seuil de 50 %");
    expect(text(details)).toContain("Rien d'oublié : the whole reading");
    expect(text(details)).toContain("Recompté : other: 1 read, 1 recounted");
  });

  it("says, small, when the cart was read more than once", () => {
    const { rerender } = render(<QuoteResult quote={quote} catalog={catalog} />);
    expect(screen.queryByText(/relu/)).not.toBeInTheDocument();

    rerender(<QuoteResult quote={{ ...quote, judge: { ...quote.judge, attempts: 2 } }} catalog={catalog} />);
    expect(screen.getByText("relu 2 fois").tagName).toBe("SMALL");
  });

  it("names films without the catalog too", () => {
    render(<QuoteResult quote={quote} />);

    expect(screen.getByText(/Lu comme Retour vers le futur II,/)).toBeInTheDocument();
  });

  it("tells what answering cost", () => {
    render(<QuoteResult quote={quote} catalog={catalog} />);

    expect(text(screen.getByText(/Réponse de l'implémentation/))).toBe(
      "Réponse de l'implémentation go (moteurs réels) en 1,8 s, pour un coût de 0,0021 $US.",
    );
  });
});
