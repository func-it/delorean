import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { catalog, problem, quote } from "@/test/fixtures";

import { QuoteWorkspace } from "./QuoteWorkspace";

vi.mock("@/app/actions", () => ({ logout: vi.fn() }));

/** Stands in for the BFF. */
function stubBff(quoteAnswer: () => Response) {
  const bff = vi.fn<typeof fetch>(async (input) =>
    String(input).startsWith("/api/catalog") ? Response.json(catalog) : quoteAnswer(),
  );
  vi.stubGlobal("fetch", bff);
  return bff;
}

describe("QuoteWorkspace", () => {
  beforeEach(() => {
    stubBff(() => Response.json(quote));
  });

  it("prices a cart through the BFF and announces the total", async () => {
    const bff = stubBff(() => Response.json(quote));
    render(<QuoteWorkspace username="marty" quoters={["go", "python"]} />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Quoter" }), "python");
    await userEvent.type(screen.getByRole("textbox", { name: "Votre panier" }), "Back to the Future 1");
    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("heading", { name: "Votre devis" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Devis prêt : 56,00\s€ à payer\./);
    expect(bff).toHaveBeenCalledWith("/api/quotes", expect.objectContaining({ method: "POST" }));
    const [, init] = bff.mock.calls.find(([input]) => input === "/api/quotes")!;
    expect(JSON.parse(String(init!.body))).toEqual({ cart: "Back to the Future 1", quoter: "python" });
  });

  it("explains a refusal and lets the visitor try again", async () => {
    stubBff(() =>
      Response.json(problem({ code: "empty_cart", status: 422 }), {
        status: 422,
        headers: { "Content-Type": "application/problem+json" },
      }),
    );
    render(<QuoteWorkspace username="marty" quoters={["go"]} />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("heading", { name: "Votre panier est vide." })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Votre panier" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Calculer le prix" })).toBeEnabled();
  });

  it("explains that the service is out of reach when the BFF is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/catalog")) return Response.json(catalog);
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<QuoteWorkspace username="marty" quoters={["go"]} />);

    await userEvent.click(screen.getByRole("button", { name: "Calculer le prix" }));

    expect(await screen.findByRole("heading", { name: "Le service de calcul ne répond pas." })).toBeInTheDocument();
  });

  it("shows the rules of the catalog", async () => {
    render(<QuoteWorkspace username="marty" quoters={["go"]} />);

    await waitFor(() => expect(screen.getByText("Tout autre film")).toBeInTheDocument());
    expect(screen.getByText("3 volets différents")).toBeInTheDocument();
    expect(screen.getByText(/2\s048 tokens, et 1\s000 exemplaires d'un même film\./)).toBeInTheDocument();
  });

  it("shows the connected username, and a quoter selector only when there is a choice", () => {
    render(<QuoteWorkspace username="marty" quoters={["go"]} />);

    expect(screen.getByText("marty")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Quoter" })).not.toBeInTheDocument();
  });
});
