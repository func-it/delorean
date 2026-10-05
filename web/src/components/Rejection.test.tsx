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
  too_many_refusals: [429, "Trop de paniers refusés."],
  quote_in_progress: [429, "Un devis est déjà en cours."],
  daily_budget_exhausted: [503, "Le vidéoclub a épuisé son budget du jour."],
  quoter_unavailable: [502, "Le service de calcul ne répond pas."],
};

describe("Rejection", () => {
  it.each(Object.entries(TITLES) as [ProblemCode, [number, string]][])(
    "explains %s in French, never with the raw problem",
    (code, [status, title]) => {
      const { container } = render(
        <Rejection problem={problem({ code, status, detail: "Raw quoter detail, in English." })} />,
      );

      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(container).not.toHaveTextContent("Raw quoter detail");
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

  it("says how many readings were made, and lists the judge checks that failed, and only those", () => {
    const unfaithful = problem({
      code: "unfaithful_reading",
      status: 422,
      judge: {
        attempts: 3,
        score: 0,
        threshold: 0.5,
        checks: [
          { check: "asked", label: "Back to the Future 2", score: 0.98 },
          { check: "identity", label: "Back to the Future 2", score: 0.24 },
          { check: "missing", label: "the whole reading", score: 0.31 },
          { check: "count", label: "bttf_2: 1 read, 3 recounted", score: 0 },
        ],
      },
    });
    render(<Rejection problem={unfaithful} />);

    expect(screen.getAllByRole("listitem").map(text)).toEqual([
      "Panier relu 3 fois.",
      "Film reconnu : Back to the Future 2 (score 24 %)",
      "Rien d'oublié : the whole reading (score 31 %)",
      "Recompté : bttf_2: 1 read, 3 recounted (score 0 %)",
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

  it("gives the guard's two answers when it reports them", () => {
    const injection = problem({
      code: "injection",
      status: 422,
      guard: { verdict: "injection", confidence: 0.97, questions: { order: 0.98, steer: 0.97 } },
    });
    render(<Rejection problem={injection} />);

    expect(screen.getAllByRole("listitem").map(text)).toEqual([
      "Verdict du garde : tentative d'injection (confiance 97 %).",
      "Commande de films : 98 % · Message adressé au système : 97 %.",
    ]);
  });

  it("says a refusal was given before to the same text, with the guard's verdict", () => {
    const remembered = problem({
      code: "injection",
      status: 422,
      remembered: true,
      guard: { verdict: "injection", confidence: 0.97 },
    });
    render(<Rejection problem={remembered} />);

    expect(screen.getByRole("heading", { name: "Ce panier a déjà été refusé." })).toBeInTheDocument();
    expect(text(screen.getByText(/tel quel/))).toBe(
      "Ce même texte a déjà été refusé parce qu'il essaie de donner des ordres au système : le renvoyer tel quel donne la même réponse. Retirez les consignes et gardez les titres.",
    );
    expect(text(screen.getByRole("listitem"))).toBe("Verdict du garde : tentative d'injection (confiance 97 %).");
  });

  it.each([
    [900, "Réessayez dans 15 minutes."],
    [61, "Réessayez dans 2 minutes."],
    [30, "Réessayez dans 1 minute."],
    [undefined, "Réessayez plus tard."],
  ])("gives the wait of a block in minutes: %s s", (retryAfter, advice) => {
    const { container } = render(
      <Rejection problem={problem({ code: "too_many_refusals", status: 429, retry_after_s: retryAfter })} />,
    );

    expect(text(screen.getByText(/suspendues/))).toBe(
      `Plusieurs textes ont été refusés parce qu'ils donnaient des ordres au système : vos demandes sont suspendues. ${advice}`,
    );
    expect(container.querySelector("section")).toHaveAttribute("data-fault", "cart");
  });

  it("asks to wait for the quote already in progress", () => {
    const { container } = render(
      <Rejection problem={problem({ code: "quote_in_progress", status: 429, retry_after_s: 1 })} />,
    );

    expect(text(screen.getByText(/attend encore/))).toBe(
      "Une autre demande de devis, pour votre session ou depuis votre connexion, attend encore sa réponse. Patientez un instant, puis réessayez.",
    );
    expect(container.querySelector("section")).toHaveAttribute("data-fault", "cart");
  });

  it("gives a reference when the fault is ours, not the cart's", () => {
    const { rerender } = render(
      <Rejection problem={problem({ code: "quoter_unavailable", status: 502, request_id: "req-88mph" })} />,
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
