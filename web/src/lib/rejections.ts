import type { Problem } from "@/lib/contract";
import { formatCount, formatPercent } from "@/lib/format";
import { CHECK_NAMES, VERDICT_NAMES } from "@/lib/labels";

export interface Rejection {
  /** One clear sentence, the whole of what the visitor reads. */
  message: string;
  /** The facts behind the refusal, e.g. the judge checks that failed; behind « détails ». */
  facts: string[];
  /** The fault is on our side: the request id, so that the trace can be found. */
  reference?: string;
}

const OUR_SIDE = "Le service est momentanément indisponible, votre panier n'est pas en cause : réessayez dans un instant.";

/** One clear French sentence per problem code; never the raw problem. */
export function explainProblem(problem: Problem): Rejection {
  const refusal = (message: string, facts: string[] = []): Rejection => ({ message, facts });
  const ours = (message: string): Rejection => ({ message, facts: [], reference: problem.request_id });

  switch (problem.code) {
    case "empty_cart":
      return refusal("Votre panier est vide : écrivez au moins un film, par exemple «\u00a0Retour vers le futur II\u00a0».");
    case "too_long":
      return refusal(
        problem.tokens
          ? `Votre panier est trop long (${formatCount(problem.tokens.count)} tokens, pour ${formatCount(problem.tokens.max)} au plus) : raccourcissez-le.`
          : "Votre panier est trop long : raccourcissez-le.",
      );
    case "payload_too_large":
      return refusal("Votre panier est trop volumineux : raccourcissez-le, puis réessayez.");
    case "injection":
      return refusal(
        problem.remembered
          ? "Ce panier a déjà été refusé, parce qu'il essaie de donner des ordres au système : retirez les consignes et gardez les titres."
          : "Ce texte essaie de donner des ordres au système : gardez seulement les titres des films.",
        guardFacts(problem),
      );
    case "invalid_request":
      return refusal("Nous n'y lisons pas une commande de films : dites-nous quels films vous voulez.", guardFacts(problem));
    case "no_film":
      return refusal("Aucun film à acheter dans ce panier : précisez les titres que vous voulez.");
    case "quantity_too_large":
      return refusal("Plus de 1\u202f000 exemplaires d'un même film : réduisez la quantité.", quantityFacts(problem));
    case "unfaithful_reading":
      return refusal(
        "Nous ne sommes pas sûrs d'avoir bien lu votre panier : reformulez-le, puis réessayez.",
        failedChecks(problem),
      );
    case "malformed_request":
      return ours("La demande n'a pas pu être lue : rechargez la page, puis réessayez.");
    case "quote_in_progress":
      return refusal("Un devis est déjà en cours pour vous : patientez un instant, puis réessayez.");
    case "daily_budget_exhausted":
      return refusal("Le vidéoclub a épuisé son budget du jour, revenez demain.");
    case "too_many_refusals":
      return refusal(`Trop de paniers refusés comme des ordres au système : vos demandes sont suspendues. ${retryAdvice(problem)}`);
    case "engine_unavailable":
    case "quoter_unavailable":
      return ours(OUR_SIDE);
    default:
      return ours(OUR_SIDE);
  }
}

function retryAdvice({ retry_after_s }: Problem): string {
  if (!retry_after_s) return "Réessayez plus tard.";
  const minutes = Math.ceil(retry_after_s / 60);
  return `Réessayez dans ${formatCount(minutes)}\u00a0minute${minutes > 1 ? "s" : ""}.`;
}

function guardFacts({ guard }: Problem): string[] {
  if (!guard) return [];
  const facts = [`Verdict du garde : ${VERDICT_NAMES[guard.verdict]} (confiance ${formatPercent(guard.confidence)}).`];
  // The two questions the verdict is made of: does it order films, does it speak to the system?
  if (guard.questions) {
    const { order, steer } = guard.questions;
    facts.push(`Commande de films : ${formatPercent(order)} · Message adressé au système : ${formatPercent(steer)}.`);
  }
  return facts;
}

function quantityFacts({ quantity }: Problem): string[] {
  if (!quantity) return [];
  const title = `«\u00a0${quantity.title}\u00a0»`;
  return [`${title} : ${formatCount(quantity.count)} exemplaires demandés, ${formatCount(quantity.max)} au plus.`];
}

function failedChecks({ judge }: Problem): string[] {
  if (!judge) return [];
  const failed = judge.checks
    .filter((check) => check.score < judge.threshold)
    .map((check) => `${CHECK_NAMES[check.check]} : ${check.label} (score ${formatPercent(check.score)})`);
  return judge.attempts > 1 ? [`Panier relu ${judge.attempts} fois.`, ...failed] : failed;
}
