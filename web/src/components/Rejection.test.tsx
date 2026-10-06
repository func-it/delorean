import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProblemCode } from "@/lib/contract";
import { problem } from "@/test/fixtures";

import { Rejection } from "./Rejection";

const text = (element: HTMLElement) => element.textContent!.replace(/[\u00a0\u202f]/g, " ");

const OUR_SIDE =
  "Le service est momentanément indisponible, votre panier n'est pas en cause : réessayez dans un instant.";

/**
 * Every code the browser can receive, with its status and its one French
 * sentence. A Record, so that a code added to the contract fails the
 * typecheck here until it has its message.
 */
const MESSAGES: Record<ProblemCode, [number, string]> = {
  malformed_request: [400, "La demande n'a pas pu être lue : rechargez la page, puis réessayez."],
  payload_too_large: [413, "Votre panier est trop volumineux : raccourcissez-le, puis réessayez."],
  empty_cart: [422, "Votre panier est vide : écrivez au moins un film, par exemple « Retour vers le futur II »."],
  too_long: [422, "Votre panier est trop long : gardez seulement les titres et les quantités."],
  injection: [422, "Ce texte essaie de donner des ordres au système : gardez seulement les titres des films."],
  invalid_request: [422, "Nous n'y lisons pas une commande de films : dites-nous quels films vous voulez."],
  no_film: [422, "Aucun film à acheter dans ce panier : précisez les titres que vous voulez."],
  quantity_too_large: [422, "Plus de 1 000 exemplaires d'un même film : réduisez la quantité."],
  demo_unreadable: [422, "Le mode démo lit un titre par ligne, avec une quantité devant si besoin (« 2 Back to the Future 2 ») : écrivez chaque titre sur sa ligne."],
  unfaithful_reading: [422, "Nous ne sommes pas sûrs d'avoir bien lu votre panier : reformulez-le, puis réessayez."],
  engine_unavailable: [502, OUR_SIDE],
  not_found: [404, OUR_SIDE],
  method_not_allowed: [405, OUR_SIDE],
  internal: [500, OUR_SIDE],
  too_many_refusals: [429, "Trop de paniers refusés comme des ordres au système : vos demandes sont suspendues. Réessayez plus tard."],
  quantity_unverified: [503, "Nous n'avons pas pu vérifier les quantités à cet instant : réessayez dans un instant."],
  rate_limited: [429, "Trop de demandes en peu de temps : réessayez dans un instant."],
  ip_budget_exhausted: [429, "Vous avez utilisé votre part du budget du jour, revenez demain."],
  quote_in_progress: [429, "Un devis est déjà en cours pour vous : patientez un instant, puis réessayez."],
  daily_budget_exhausted: [503, "Le vidéoclub a épuisé son budget du jour, revenez demain."],
  quoter_unavailable: [502, OUR_SIDE],
};

describe("Rejection", () => {
  it.each(Object.entries(MESSAGES) as [ProblemCode, [number, string]][])(
    "says %s in one French sentence, never with the raw problem",
    (code, [status, message]) => {
      const { container } = render(
        <Rejection problem={problem({ code, status, detail: "Raw quoter detail, in English." })} />,
      );

      expect(text(screen.getByText(/^\S/, { selector: "p" }))).toBe(message);
      expect(container).not.toHaveTextContent("Raw quoter detail");
      expect(container).not.toHaveTextContent(code);
      expect(screen.queryByText("détails")).not.toBeInTheDocument();
    },
  );

  it.each([
    [30, "Trop de demandes en peu de temps : réessayez dans 30 secondes."],
    [1, "Trop de demandes en peu de temps : réessayez dans 1 seconde."],
    [undefined, "Trop de demandes en peu de temps : réessayez dans un instant."],
  ])("gives the wait of a rate limit in seconds: %s", (retryAfter, sentence) => {
    const { container } = render(<Rejection problem={problem({ code: "rate_limited", status: 429, retry_after_s: retryAfter })} />);

    expect(text(container)).toBe(sentence);
  });

  it("says the budget is spent, and nothing else", () => {
    const { container } = render(<Rejection problem={problem({ code: "daily_budget_exhausted", status: 503, retry_after_s: 3600 })} />);

    expect(text(container)).toBe("Le vidéoclub a épuisé son budget du jour, revenez demain.");
  });

  it("says a cart is too long in words a customer uses, never tokens", () => {
    render(<Rejection problem={problem({ code: "too_long", status: 422, tokens: { count: 3120, max: 256 } })} />);

    const sentence = text(screen.getByText(/trop long/));
    expect(sentence).toBe("Votre panier est trop long : gardez seulement les titres et les quantités.");
    expect(sentence).not.toMatch(/token/i);
  });

  it.each([
    [900, "Réessayez dans 15 minutes."],
    [61, "Réessayez dans 2 minutes."],
    [30, "Réessayez dans 1 minute."],
    [undefined, "Réessayez plus tard."],
  ])("gives the wait of a block in minutes: %s s", (retryAfter, advice) => {
    render(<Rejection problem={problem({ code: "too_many_refusals", status: 429, retry_after_s: retryAfter })} />);

    expect(text(screen.getByText(/suspendues/))).toBe(
      `Trop de paniers refusés comme des ordres au système : vos demandes sont suspendues. ${advice}`,
    );
  });

  it("says a refusal was given before to the same text", () => {
    render(<Rejection problem={problem({ code: "injection", status: 422, remembered: true })} />);

    expect(text(screen.getByText(/déjà été refusé/))).toBe(
      "Ce panier a déjà été refusé, parce qu'il essaie de donner des ordres au système : retirez les consignes et gardez les titres.",
    );
  });

  it("keeps the facts behind a single « détails »: the judge checks that failed, and only those", async () => {
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
          { check: "count", label: "bttf_2: 1 read, 3 recounted", score: 0 },
        ],
      },
    });
    render(<Rejection problem={unfaithful} />);
    const summary = screen.getByText("détails");
    expect(summary.closest("details")).not.toHaveAttribute("open");

    await userEvent.click(summary);

    expect(screen.getAllByRole("listitem").map(text)).toEqual([
      "Panier relu 3 fois.",
      "Film reconnu : Back to the Future 2 (score 24 %)",
      "Recompté : bttf_2: 1 read, 3 recounted (score 0 %)",
    ]);
  });

  it("gives the guard's verdict and its two answers in the details of an injection", () => {
    const injection = problem({
      code: "injection",
      status: 422,
      guard: { verdict: "injection", confidence: 0.97, questions: { order: 0.98, steer: 0.97 } },
    });
    render(<Rejection problem={injection} />);

    expect(screen.getAllByRole("listitem", { hidden: true }).map(text)).toEqual([
      "Verdict du garde : tentative d'injection (confiance 97 %).",
      "Commande de films : 98 % · Message adressé au système : 97 %.",
    ]);
  });

  it("names the title asked in too many copies, in the details", () => {
    const tooMany = problem({
      code: "quantity_too_large",
      status: 422,
      quantity: { title: "Back to the Future 2", count: 1001, max: 1000 },
    });
    render(<Rejection problem={tooMany} />);

    expect(text(screen.getByRole("listitem", { hidden: true }))).toBe(
      "« Back to the Future 2 » : 1 001 exemplaires demandés, 1 000 au plus.",
    );
  });

  it("gives a reference, in the details, when the fault is ours, not the cart's", () => {
    const { rerender } = render(
      <Rejection problem={problem({ code: "quoter_unavailable", status: 502, request_id: "req-88mph" })} />,
    );
    expect(screen.getByText("req-88mph")).toBeInTheDocument();

    rerender(<Rejection problem={problem({ code: "empty_cart", status: 422, request_id: "req-88mph" })} />);
    expect(screen.queryByText("req-88mph")).not.toBeInTheDocument();
  });

  it("has no « détails » when there is nothing to put in it, the usage of the answer included", () => {
    const priced = problem({
      code: "injection",
      status: 422,
      usage: { engines: "fake", duration_ms: 12, cost_usd: 0, stages: [] },
    });
    render(<Rejection problem={priced} />);

    expect(screen.queryByText("détails")).not.toBeInTheDocument();
  });
});
