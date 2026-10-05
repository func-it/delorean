import type { Film, GuardOutcome, JudgeCheck } from "@/lib/contract";

/** Below this, an identification is shown as "à vérifier". */
export const LOW_CONFIDENCE = 0.7;

export const CHECK_NAMES: Record<JudgeCheck["check"], string> = {
  asked: "Film demandé",
  identity: "Film reconnu",
  missing: "Rien d'oublié",
  count: "Recompté",
};

export const VERDICT_NAMES: Record<GuardOutcome["verdict"], string> = {
  valid: "commande valide",
  injection: "tentative d'injection",
  invalid: "hors sujet",
};

const SAGA_TITLES: Record<Exclude<Film, "other">, string> = {
  bttf_1: "Retour vers le futur",
  bttf_2: "Retour vers le futur II",
  bttf_3: "Retour vers le futur III",
};

/** What a title was identified as. */
export function filmLabel(film: Film): string {
  return film === "other" ? "Autre film" : SAGA_TITLES[film];
}
