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
    case "backend_unavailable":
      return rejection("Le service de calcul ne répond pas.", OUR_SIDE, { showReference: true });
    case "malformed_request":
      return rejection("La demande n'a pas pu être lue.", "Rechargez la page, puis réessayez.", { showReference: true });
    case "no_session":
      return rejection("Votre session a expiré.", "Reconnectez-vous pour continuer.", { relogin: true });
    default:
      return rejection("Une erreur inattendue est survenue.", OUR_SIDE, { showReference: true });
  }
}

function guardFacts({ guard }: Problem): string[] {
  return guard ? [`Verdict du garde : ${VERDICT_NAMES[guard.verdict]} (confiance ${formatPercent(guard.confidence)}).`] : [];
}

function quantityFacts({ quantity }: Problem): string[] {
  if (!quantity) return [];
  const title = `«\u00a0${quantity.title}\u00a0»`;
  return [`${title} : ${formatCount(quantity.count)} exemplaires demandés, ${formatCount(quantity.max)} au plus.`];
}

function failedChecks({ judge }: Problem): string[] {
  if (!judge) return [];
  return judge.checks
    .filter((check) => check.score < judge.threshold)
    .map((check) => `${CHECK_NAMES[check.check]} : ${check.label} (score ${formatPercent(check.score)})`);
}
