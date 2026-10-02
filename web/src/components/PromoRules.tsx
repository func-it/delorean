import type { Catalog } from "@/lib/contract";
import { formatCents, formatCount, formatPercent } from "@/lib/format";

import styles from "./PromoRules.module.css";
import type { CatalogState } from "./useCatalog";

export function PromoRules({ catalog }: { catalog: CatalogState }) {
  return (
    <aside className={styles.rules} aria-labelledby="rules-title" aria-busy={catalog.status === "loading"}>
      <h2 id="rules-title" className={styles.title}>
        Les règles du vidéoclub
      </h2>
      {catalog.status === "loading" && <p className={styles.note}>Chargement des règles…</p>}
      {catalog.status === "failed" && (
        <p className={styles.note}>Les règles n&apos;ont pas pu être chargées. Le calcul du prix, lui, les applique toujours.</p>
      )}
      {catalog.status === "ready" && <Rules catalog={catalog.catalog} />}
    </aside>
  );
}

function Rules({ catalog }: { catalog: Catalog }) {
  const tiers = catalog.saga_discounts.toSorted((a, b) => a.distinct_volumes - b.distinct_volumes);

  return (
    <>
      <section className={styles.section} aria-labelledby="prices-title">
        <h3 id="prices-title" className={styles.subtitle}>
          Prix du DVD
        </h3>
        <dl className={styles.table}>
          {catalog.films.map((film) => (
            <div key={film.id} className={styles.row}>
              <dt>{film.title}</dt>
              <dd>{formatCents(film.unit_price_cents)}</dd>
            </div>
          ))}
          <div className={styles.row}>
            <dt>Tout autre film</dt>
            <dd>{formatCents(catalog.other_film_unit_price_cents)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="discounts-title">
        <h3 id="discounts-title" className={styles.subtitle}>
          Remise sur la saga
        </h3>
        <p className={styles.note}>
          Sur chaque DVD de la saga, doublons compris, selon le nombre de volets différents du panier.
        </p>
        <dl className={styles.table}>
          {tiers.map((tier) => (
            <div key={tier.distinct_volumes} className={styles.row}>
              <dt>{tier.distinct_volumes} volets différents</dt>
              <dd>−{formatPercent(tier.percent / 100)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className={styles.note}>
        Un panier compte au plus {formatCount(catalog.limits.max_input_tokens)} tokens, et{" "}
        {formatCount(catalog.limits.max_copies_per_title)} exemplaires d&apos;un même film.
      </p>
    </>
  );
}
