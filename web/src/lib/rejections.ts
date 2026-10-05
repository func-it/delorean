import type { Problem } from "@/lib/contract";
import { formatCount, formatPercent } from "@/lib/format";
import { CHECK_NAMES, VERDICT_NAMES } from "@/lib/labels";

export interface Rejection {
  title: string;
  detail: string;
  /** The facts behind the refusal, e.g. the judge checks that failed. */
  facts: string[];
  /** The fault is on our side: show the request id so the trace can be found. */
  showReference: boolean;
  /** The session is gone: offer to log in again. */
  relogin: boolean;
}

const OUR_SIDE = "Votre panier n'est pas en cause. Réessayez dans un instant.";

/** One clear French message per problem code; never the raw problem. */
export function explainProblem(problem: Problem): Rejection {
  const rejection = (title: string, detail: string, extra: Partial<Rejection> = {}): Rejection => ({
    title,
    detail,
    facts: [],
    showReference: false,
    relogin: false,
    ...extra,
  });

  switch (problem.code) {
    case "empty_cart":
      return rejection("Votre panier est vide.", "Écrivez au moins un film, par exemple «\u00a0Retour vers le futur II\u00a0».");
    case "too_long":
      return rejection(
        "Votre panier est trop long.",
        problem.tokens
          ? `Il compte ${formatCount(problem.tokens.count)} tokens, pour ${formatCount(problem.tokens.max)} au plus. Raccourcissez-le, puis réessayez.`
          : "Raccourcissez-le, puis réessayez.",
      );
    case "payload_too_large":
      return rejection("Votre panier est trop volumineux.", "Le texte dépasse ce que le service accepte. Raccourcissez-le, puis réessayez.");
    case "injection":
      if (problem.remembered) {
        return rejection(
          "Ce panier a déjà été refusé.",
          "Ce même texte a déjà été refusé parce qu'il essaie de donner des ordres au système : le renvoyer tel quel donne la même réponse. Retirez les consignes et gardez les titres.",
          { facts: guardFacts(problem) },
        );
      }
      return rejection(
        "Ce texte essaie de donner des ordres au système.",
        "Nous ne chiffrons que des commandes de films : retirez les consignes (changer les prix, ignorer les règles…) et gardez les titres.",
        { facts: guardFacts(problem) },
      );
    case "invalid_request":
      return rejection(
        "Nous n'y lisons pas une commande de films.",
        "Le texte semble hors sujet ou illisible. Dites-nous quels films vous voulez, dans la langue de votre choix.",
        { facts: guardFacts(problem) },
      );
    case "no_film":
      return rejection(
        "Aucun film à acheter dans ce panier.",
        "Le texte parle peut-être de films, mais n'en commande aucun. Précisez les titres que vous voulez acheter.",
      );
    case "quantity_too_large":
      return rejection(
        "Plus de 1\u202f000 exemplaires d'un même film.",
        "La boutique ne peut pas servir cette commande : réduisez la quantité, puis réessayez.",
        { facts: quantityFacts(problem) },
      );
    case "unfaithful_reading":
      return rejection(
        "Nous ne sommes pas sûrs d'avoir bien lu votre panier.",
        "Plutôt que de risquer un prix faux, nous préférons ne pas chiffrer. Reformulez ce qui suit, puis réessayez.",
        { facts: failedChecks(problem) },
      );
    case "engine_unavailable":
      return rejection("Notre service de lecture est momentanément indisponible.", OUR_SIDE, { showReference: true });
    case "quoter_unavailable":
      return rejection("Le service de calcul ne répond pas.", OUR_SIDE, { showReference: true });
    case "malformed_request":
      return rejection("La demande n'a pas pu être lue.", "Rechargez la page, puis réessayez.", { showReference: true });
    case "no_session":
      return rejection("Votre session a expiré.", "Reconnectez-vous pour continuer.", { relogin: true });
    case "quote_in_progress":
      return rejection(
        "Un devis est déjà en cours.",
        "Une autre demande de devis, pour votre session ou depuis votre connexion, attend encore sa réponse. Patientez un instant, puis réessayez.",
      );
    case "daily_budget_exhausted":
      return rejection(
        "Le vidéoclub a épuisé son budget du jour.",
        "Le budget de lecture des paniers est dépensé pour aujourd'hui. Revenez demain, votre panier n'est pas en cause.",
      );
    case "too_many_refusals":
      return rejection(
        "Trop de paniers refusés.",
        `Plusieurs textes ont été refusés parce qu'ils donnaient des ordres au système : vos demandes sont suspendues. ${retryAdvice(problem)}`,
      );
    default:
      return rejection("Une erreur inattendue est survenue.", OUR_SIDE, { showReference: true });
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
