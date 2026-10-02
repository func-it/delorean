import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProblemCode } from "@/lib/contract";
import { problem } from "@/test/fixtures";

import { Rejection } from "./Rejection";

const text = (element: HTMLElement) => element.textContent!.replace(/[\u00a0\u202f]/g, " ");

/**
 * Every code the browser can receive, with its status and French title. A
 * Record, so that a code added to the contract fails the typecheck here until
 * it has its message.
 */
const TITLES: Record<ProblemCode, [number, string]> = {
  malformed_request: [400, "La demande n'a pas pu être lue."],
  payload_too_large: [413, "Votre panier est trop volumineux."],
  empty_cart: [422, "Votre panier est vide."],
  too_long: [422, "Votre panier est trop long."],
  injection: [422, "Ce texte essaie de donner des ordres au système."],
  invalid_request: [422, "Nous n'y lisons pas une commande de films."],
  no_film: [422, "Aucun film à acheter dans ce panier."],
  quantity_too_large: [422, "Plus de 1\u202f000 exemplaires d'un même film."],
  unfaithful_reading: [422, "Nous ne sommes pas sûrs d'avoir bien lu votre panier."],
  engine_unavailable: [502, "Notre service de lecture est momentanément indisponible."],
  not_found: [404, "Une erreur inattendue est survenue."],
  method_not_allowed: [405, "Une erreur inattendue est survenue."],
  internal: [500, "Une erreur inattendue est survenue."],
  no_session: [401, "Votre session a expiré."],
  backend_unavailable: [502, "Le service de calcul ne répond pas."],
};

describe("Rejection", () => {
  it.each(Object.entries(TITLES) as [ProblemCode, [number, string]][])(
    "explains %s in French, never with the raw problem",
    (code, [status, title]) => {
      const { container } = render(
        <Rejection problem={problem({ code, status, detail: "Raw backend detail, in English." })} />,
      );

      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(container).not.toHaveTextContent("Raw backend detail");
      expect(container).not.toHaveTextContent(code);
    },
  );

  it("names the title asked in too many copies, in French", () => {
    const tooMany = problem({
      code: "quantity_too_large",
      status: 422,
      quantity: { title: "Back to the Future 2", count: 1001, max: 1000 },
    });
    render(<Rejection problem={tooMany} />);

    expect(text(screen.getByRole("listitem"))).toBe("« Back to the Future 2 » : 1 001 exemplaires demandés, 1 000 au plus.");
  });

  it("keeps the general advice when the problem does not say which title", () => {
    render(<Rejection problem={problem({ code: "quantity_too_large", status: 422 })} />);

    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(text(screen.getByText(/ne peut pas servir/))).toBe(
      "La boutique ne peut pas servir cette commande : réduisez la quantité, puis réessayez.",
    );
  });

  it("gives the token counts of a cart too long", () => {
    render(<Rejection problem={problem({ code: "too_long", status: 422, tokens: { count: 3120, max: 2048 } })} />);

    expect(text(screen.getByText(/Il compte/))).toBe(
      "Il compte 3 120 tokens, pour 2 048 au plus. Raccourcissez-le, puis réessayez.",
    );
  });

  it("lists the judge checks that failed, and only those", () => {
    const unfaithful = problem({
      code: "unfaithful_reading",
      status: 422,
      judge: {
        score: 0.12,
        threshold: 0.5,
        checks: [
          { check: "asked", label: "Back to the Future 2", score: 0.98 },
          { check: "identity", label: "Back to the Future 2", score: 0.24 },
          { check: "quantity", label: "Back to the Future 2 × 3", score: 0.12 },
          { check: "missing", label: "the whole reading", score: 0.31 },
        ],
      },
    });
    render(<Rejection problem={unfaithful} />);

    expect(screen.getAllByRole("listitem").map(text)).toEqual([
      "Film reconnu : Back to the Future 2 (score 24 %)",
      "Quantité : Back to the Future 2 × 3 (score 12 %)",
      "Rien d'oublié : the whole reading (score 31 %)",
    ]);
  });

  it("gives the guard's verdict on an injection", () => {
    const injection = problem({
      code: "injection",
      status: 422,
      guard: { verdict: "injection", confidence: 0.97 },
    });
    render(<Rejection problem={injection} />);

    expect(text(screen.getByRole("listitem"))).toBe("Verdict du garde : tentative d'injection (confiance 97 %).");
  });

  it("gives a reference when the fault is ours, not the cart's", () => {
    const { rerender } = render(
      <Rejection problem={problem({ code: "backend_unavailable", status: 502, request_id: "req-88mph" })} />,
    );
    expect(screen.getByText("req-88mph")).toBeInTheDocument();

    rerender(<Rejection problem={problem({ code: "empty_cart", status: 422, request_id: "req-88mph" })} />);
    expect(screen.queryByText("req-88mph")).not.toBeInTheDocument();
  });

  it("offers to log in again when the session is gone", () => {
    render(<Rejection problem={problem({ code: "no_session", status: 401 })} />);

    expect(screen.getByRole("link", { name: "Se reconnecter" })).toHaveAttribute("href", "/login");
  });

  it("tells what a refusal cost", () => {
    const priced = problem({
      code: "injection",
      status: 422,
      usage: { implementation: "python", engines: "fake", duration_ms: 12, cost_usd: 0, stages: [] },
    });
    render(<Rejection problem={priced} />);

    expect(text(screen.getByText(/Réponse de l'implémentation/))).toBe(
      "Réponse de l'implémentation python (moteurs factices) en 12 ms, pour un coût de 0,00 $US.",
    );
  });
});
