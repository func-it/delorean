import type { Catalog, Discount, JudgeOutcome, Quote, QuoteLine } from "@/lib/contract";
import { formatCents, formatPercent } from "@/lib/format";
import { CHECK_NAMES, filmLabel, LOW_CONFIDENCE } from "@/lib/labels";

import styles from "./QuoteResult.module.css";
import { UsageLine } from "./UsageLine";

interface Props {
  quote: Quote;
  /** For the films' names; built-in names are used until it loads. */
  catalog?: Catalog;
}

export function QuoteResult({ quote, catalog }: Props) {
  return (
    <section className={styles.result} aria-labelledby="quote-title">
      <h2 id="quote-title" className={styles.title}>
        Votre devis
      </h2>

      <table className={styles.lines}>
        <caption className="visually-hidden">Les films lus dans votre panier, et leur prix</caption>
        <thead>
          <tr>
            <th scope="col">Film</th>
            <th scope="col" className={styles.number}>
              <abbr title="Quantité">Qté</abbr>
            </th>
            <th scope="col" className={styles.number}>
              Prix unitaire
            </th>
            <th scope="col" className={styles.number}>
              Sous-total
            </th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((line, index) => (
            <Line key={index} line={line} catalog={catalog} />
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Sous-total
            </th>
            <td className={styles.number}>{formatCents(quote.subtotal_cents)}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={3}>
              Remise sur la saga
              <span className={styles.secondary}>{discountNote(quote.discount)}</span>
            </th>
            <td className={styles.number}>
              {quote.discount.amount_cents > 0 ? `−${formatCents(quote.discount.amount_cents)}` : "—"}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* The one nod to the car: the total on a time-circuit display. */}
      <dl className={styles.circuit}>
        <dt>Total à payer</dt>
        <dd>{formatCents(quote.total_cents)}</dd>
      </dl>

      <Judge judge={quote.judge} />
      <UsageLine usage={quote.usage} />
    </section>
  );
}

function Line({ line, catalog }: { line: QuoteLine; catalog?: Catalog }) {
  const doubtful = line.confidence < LOW_CONFIDENCE;
  return (
    <tr>
      <th scope="row">
        <span className={styles.written}>{`«\u00a0${line.title}\u00a0»`}</span>
        <span className={styles.secondary}>
          Lu comme {filmLabel(line.film, catalog)}, confiance {formatPercent(line.confidence)}
          {doubtful && <span className={styles.badge}>à vérifier</span>}
        </span>
      </th>
      <td className={styles.number}>{line.quantity}</td>
      <td className={styles.number}>{formatCents(line.unit_price_cents)}</td>
      <td className={styles.number}>{formatCents(line.subtotal_cents)}</td>
    </tr>
  );
}

function discountNote({ distinct_volumes, percent, base_cents }: Discount): string {
  if (percent > 0) {
    return `${distinct_volumes} volets différents : ${formatPercent(percent / 100)} sur ${formatCents(base_cents)} de DVD de la saga.`;
  }
  if (distinct_volumes === 1) return "Un seul volet : la remise commence à deux volets différents.";
  return "Aucun volet de la saga dans ce panier.";
}

function Judge({ judge }: { judge: JudgeOutcome }) {
  return (
    <details className={styles.why}>
      <summary>
        Pourquoi ce prix ?
        {judge.attempts > 1 && <small className={styles.reread}>relu {judge.attempts} fois</small>}
      </summary>
      <div className={styles.whyBody}>
        <p>
          Un modèle a lu les films de votre texte ; avant de chiffrer, un juge a vérifié cette lecture, une courte question
          par fait. La moins bonne réponse fait le score : {formatPercent(judge.score)}, pour un seuil de{" "}
          {formatPercent(judge.threshold)}. Le prix, lui, est calculé par le code, à partir du catalogue.
        </p>
        <ul className={styles.checks}>
          {judge.checks.map((check, index) => (
            <li key={index}>
              <span>
                {CHECK_NAMES[check.check]} : {check.label}
              </span>
              <span className={styles.score}>{formatPercent(check.score)}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
