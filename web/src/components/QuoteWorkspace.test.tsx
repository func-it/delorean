import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { describePrices } from "@/lib/shelf";
import { catalog, problem, quote } from "@/test/fixtures";

import { cartBytes } from "@/lib/size";

import { QuoteWorkspace } from "./QuoteWorkspace";

/** Stands in for the BFF. */
function stubBff(answer: () => Response) {
  const bff = vi.fn<typeof fetch>(async () => answer());
  vi.stubGlobal("fetch", bff);
  return bff;
}

/** The refusal as shown (the same sentence is also announced to screen readers, hidden). */
const refusal = async () => within(await screen.findByRole("region", { name: "Refus" }));

const problemAnswer = (code: Parameters<typeof problem>[0]["code"], status: number) =>
  Response.json(problem({ code, status }), { status, headers: { "Content-Type": "application/problem+json" } });

describe("QuoteWorkspace", () => {
  beforeEach(() => {
    stubBff(() => Response.json(quote));
  });

  it("is one page: a title, a text area, a button, and the quoter's prices in a footer", () => {
    render(<QuoteWorkspace prices={describePrices(catalog)} />);

    expect(screen.getByRole("heading", { level: 1, name: "Delorean" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Votre panier" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/15,00\s€ le DVD, tout autre film\s: 20,00\s€/);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("has no footer when the quoter gave no prices, and invents none", () => {
    render(<QuoteWorkspace />);

    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("says it is a demo, first, when the quoter reads with its fake engines, and offers only what they read", () => {
    render(<QuoteWorkspace engines="fake" />);

    const banner = screen.getByRole("complementary", { name: "Mode démo" });
    expect(banner).toHaveTextContent("Mode démo : lecteur simplifié, pas d'IA.");
    expect(screen.queryByRole("button", { name: "Plusieurs langues" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Les trois volets" })).toBeInTheDocument();
  });

  it("shows no banner, and every example, with the real models or when the quoter did not say", () => {
    const { rerender } = render(<QuoteWorkspace engines="live" />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plusieurs langues" })).toBeInTheDocument();

    rerender(<QuoteWorkspace />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plusieurs langues" })).toBeInTheDocument();
  });

  it("prices a cart through the BFF and announces the total", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace />);

    await userEvent.type(screen.getByRole("textbox", { name: "Votre panier" }), "Back to the Future 1");
    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("region", { name: "Prix de la commande" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Prix de la commande : 56,00\s€\./);
    expect(bff).toHaveBeenCalledTimes(1);
    const [path, init] = bff.mock.calls[0];
    expect(path).toBe("/api/quotes");
    expect(JSON.parse(String(init!.body))).toEqual({ cart: "Back to the Future 1" });
  });

  it("says a refusal in one sentence and lets the visitor try again", async () => {
    stubBff(() => problemAnswer("empty_cart", 422));
    render(<QuoteWorkspace />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText(/Votre panier est vide/)).toBeInTheDocument();
    expect(screen.queryByText("détails")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Votre panier" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeEnabled();
  });

  it("tells the visitor to come back tomorrow when the budget is spent", async () => {
    stubBff(() => problemAnswer("daily_budget_exhausted", 503));
    render(<QuoteWorkspace />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText("Le vidéoclub a épuisé son budget du jour, revenez demain.")).toBeInTheDocument();
  });

  it("does not send a cart over the size the BFF reads, and says so", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace limits={{ maxBodyBytes: 200, maxInputTokens: 256 }} />);

    await userEvent.click(screen.getByRole("textbox", { name: "Votre panier" }));
    await userEvent.paste("é".repeat(120));

    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeDisabled();
    expect(screen.getByText(/Votre panier dépasse 0\sKo/)).toBeInTheDocument();
    expect(bff).not.toHaveBeenCalled();
  });

  it("sends a cart that is exactly the size the quoter reads", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace limits={{ maxBodyBytes: cartBytes("Back to the Future 1"), maxInputTokens: 256 }} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Votre panier" }), "Back to the Future 1");
    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("region", { name: "Prix de la commande" })).toBeInTheDocument();
    expect(bff).toHaveBeenCalledTimes(1);
  });

  it("explains a 413 that is not a problem, a proxy's page, as a cart too large", async () => {
    stubBff(() => new Response("<html><h1>413 Request Entity Too Large</h1></html>", { status: 413, headers: { "Content-Type": "text/html" } }));
    render(<QuoteWorkspace />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText(/Votre panier est trop volumineux/)).toBeInTheDocument();
  });

  it("says the service is out of reach when the BFF is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<QuoteWorkspace />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText(/momentanément indisponible/)).toBeInTheDocument();
  });
});
