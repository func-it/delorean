import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Quote } from "@/lib/contract";
import { quote } from "@/test/fixtures";

import { QuoteResult } from "./QuoteResult";

/** Intl puts no-break spaces in amounts: compare text with plain spaces. */
const text = (element: HTMLElement) => element.textContent!.replace(/[\u00a0\u202f]/g, " ");

describe("QuoteResult", () => {
  it("shows the total, big", () => {
    render(<QuoteResult quote={quote} />);

    expect(text(screen.getByText("56,00 €", { selector: "p" }))).toBe("Total à payer : 56,00 €");
  });

  it("lists the recognized film, the quantity and the price of every line, then the saga discount", () => {
    render(<QuoteResult quote={quote} />);

    const items = within(screen.getAllByRole("list")[0]).getAllByRole("listitem").map(text);
    expect(items).toEqual([
      "Retour vers le futur × 1 15,00 €",
      "Retour vers le futur II × 1 15,00 €",
      "Retour vers le futur III × 1 15,00 €",
      "La chèvre × 1 20,00 €",
      "Remise saga 3 volets, −20 % −9,00 €",
    ]);
  });

  it("adds no discount line when there is no discount", () => {
    const single: Quote = {
      ...quote,
      discount: { distinct_volumes: 1, percent: 0, base_cents: 1500, amount_cents: 0 },
    };
    render(<QuoteResult quote={single} />);

    expect(screen.queryByText(/Remise saga/)).not.toBeInTheDocument();
  });

  it("keeps everything else behind a single « détails », closed", () => {
    render(<QuoteResult quote={quote} />);

    const summaries = screen.getAllByText("détails");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("Pourquoi ce prix ?")).not.toBeInTheDocument();
  });

  it("explains the reading, the judge and the cost, on demand", async () => {
    render(<QuoteResult quote={quote} />);
    const summary = screen.getByText("détails");

    await userEvent.click(summary);

    const details = summary.closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(text(details)).toContain("« BTTF 2 » lu comme Retour vers le futur II, confiance 95 %");
    expect(text(details)).toContain("« La chèvre » lu comme Autre film, confiance 62 %");
    expect(text(details)).toContain("91 %, pour un seuil de 50 %");
    expect(text(details)).toContain("Rien d'oublié : the whole reading");
    expect(text(details)).toContain("Réponse de l'implémentation typescript (moteurs réels) en 1,8 s, pour un coût de 0,0021 $US.");
  });

  it("flags only the doubtful identifications, in the details", () => {
    render(<QuoteResult quote={quote} />);

    const flagged = screen.getAllByText("à vérifier", { exact: true });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].closest("li")).toHaveTextContent("La chèvre");
  });

  it("says when the cart was read more than once", () => {
    const { rerender } = render(<QuoteResult quote={quote} />);
    expect(screen.queryByText(/relu/)).not.toBeInTheDocument();

    rerender(<QuoteResult quote={{ ...quote, judge: { ...quote.judge, attempts: 2 } }} />);
    expect(screen.getByText(/relu 2 fois/)).toBeInTheDocument();
  });
});
