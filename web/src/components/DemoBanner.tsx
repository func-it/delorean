import styles from "./DemoBanner.module.css";

/** On the quoter's fake engines the page says so, first thing: what it reads is a stand-in, not the models. */
export function DemoBanner() {
  return (
    <aside className={styles.banner} aria-label="Mode démo">
      <p>
        <strong>Mode démo : lecteur simplifié, pas d&apos;IA.</strong> Les prix sont justes pour les titres «&nbsp;Back to
        the Future 1&nbsp;», «&nbsp;2&nbsp;» et «&nbsp;3&nbsp;» écrits tels quels ; tout autre texte demande les vrais
        modèles : lancez l&apos;application avec une clé.
      </p>
    </aside>
  );
}
