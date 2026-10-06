import styles from "./DemoBanner.module.css";

/** On the quoter's fake engines the page says so, first thing: what it reads is a stand-in, not the models. */
export function DemoBanner() {
  return (
    <aside className={styles.banner} aria-label="Mode démo">
      <p>
        <strong>Mode démo : lecteur simplifié, pas d&apos;IA.</strong> Il lit un titre par ligne, avec une
        quantité devant si besoin («&nbsp;2 Back to the Future 2&nbsp;») ; une ligne qui nomme la saga sans être l&apos;un de
        ses titres est refusée. Pour du texte libre, lancez l&apos;application avec une clé.
      </p>
    </aside>
  );
}
