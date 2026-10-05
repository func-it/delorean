import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { problem, quote } from "@/test/fixtures";

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

  it("is one page: a title, a text area, a button, and the rules in a footer", () => {
    render(<QuoteWorkspace quoter="go" />);

    expect(screen.getByRole("heading", { level: 1, name: "Delorean" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Votre panier" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/15\s€ le DVD, tout autre film\s: 20\s€/);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("prices a cart through the BFF with the quoter it was given, and announces the total", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace quoter="python" />);

    await userEvent.type(screen.getByRole("textbox", { name: "Votre panier" }), "Back to the Future 1");
    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("region", { name: "Prix de la commande" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Prix de la commande : 56,00\s€\./);
    expect(bff).toHaveBeenCalledTimes(1);
    const [path, init] = bff.mock.calls[0];
    expect(path).toBe("/api/quotes");
    expect(JSON.parse(String(init!.body))).toEqual({ cart: "Back to the Future 1", quoter: "python" });
  });

  it("says a refusal in one sentence and lets the visitor try again", async () => {
    stubBff(() => problemAnswer("empty_cart", 422));
    render(<QuoteWorkspace quoter="go" />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText(/Votre panier est vide/)).toBeInTheDocument();
    expect(screen.queryByText("détails")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Votre panier" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeEnabled();
  });

  it("tells the visitor to come back tomorrow when the budget is spent", async () => {
    stubBff(() => problemAnswer("daily_budget_exhausted", 503));
    render(<QuoteWorkspace quoter="go" />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText("Le vidéoclub a épuisé son budget du jour, revenez demain.")).toBeInTheDocument();
  });

  it("does not send a cart over the size the BFF reads, and says so", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace quoter="go" limits={{ maxBodyBytes: 200, maxInputTokens: 256 }} />);

    await userEvent.click(screen.getByRole("textbox", { name: "Votre panier" }));
    await userEvent.paste("é".repeat(120));

    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeDisabled();
    expect(screen.getByText(/Votre panier dépasse 0\sKo/)).toBeInTheDocument();
    expect(bff).not.toHaveBeenCalled();
  });

  it("sends a cart that is exactly the size the quoters read", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace quoter="go" limits={{ maxBodyBytes: cartBytes("Back to the Future 1"), maxInputTokens: 256 }} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Votre panier" }), "Back to the Future 1");
    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("region", { name: "Prix de la commande" })).toBeInTheDocument();
    expect(bff).toHaveBeenCalledTimes(1);
  });

  it("explains a 413 that is not a problem, a proxy's page, as a cart too large", async () => {
    stubBff(() => new Response("<html><h1>413 Request Entity Too Large</h1></html>", { status: 413, headers: { "Content-Type": "text/html" } }));
    render(<QuoteWorkspace quoter="go" />);

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
    render(<QuoteWorkspace quoter="go" />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect((await refusal()).getByText(/momentanément indisponible/)).toBeInTheDocument();
  });
});
