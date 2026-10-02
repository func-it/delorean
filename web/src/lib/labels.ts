import type { Catalog, Film, GuardOutcome, JudgeCheck } from "@/lib/contract";

/** Below this, an identification is shown as "à vérifier". */
export const LOW_CONFIDENCE = 0.7;

export const CHECK_NAMES: Record<JudgeCheck["check"], string> = {
  asked: "Film demandé",
  identity: "Film reconnu",
  quantity: "Quantité",
  missing: "Rien d'oublié",
};

export const VERDICT_NAMES: Record<GuardOutcome["verdict"], string> = {
  valid: "commande valide",
  injection: "tentative d'injection",
  invalid: "hors sujet",
};

/** Used until the catalog is loaded, or if it cannot be. */
const SAGA_TITLES: Record<Exclude<Film, "other">, string> = {
  bttf_1: "Retour vers le futur",
  bttf_2: "Retour vers le futur II",
  bttf_3: "Retour vers le futur III",
};

/** What a title was identified as, in the catalog's words. */
export function filmLabel(film: Film, catalog?: Catalog): string {
  if (film === "other") return "Autre film";
  return catalog?.films.find((entry) => entry.id === film)?.title ?? SAGA_TITLES[film];
}
