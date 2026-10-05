import type { Discount, JudgeOutcome, Quote, QuoteLine } from "@/lib/contract";
import { formatCents, formatPercent } from "@/lib/format";
import { CHECK_NAMES, filmLabel, LOW_CONFIDENCE } from "@/lib/labels";

import styles from "./QuoteResult.module.css";
import { UsageLine } from "./UsageLine";

/** The price, the lines it is made of, the saga discount; how it was read stays behind « détails ». */
export function QuoteResult({ quote }: { quote: Quote }) {
  const { discount } = quote;
  return (
    <section className={styles.result} aria-label="Prix de la commande">
      <p className={styles.total}>
        <span className="visually-hidden">Total à payer : </span>
        {formatCents(quote.total_cents)}
      </p>

      <ul className={styles.lines}>
        {quote.lines.map((line, index) => (
          <li key={index}>
            <span>
              {recognized(line)} <span className={styles.quantity}>× {line.quantity}</span>
            </span>{" "}
            <span className={styles.amount}>{formatCents(line.subtotal_cents)}</span>
          </li>
        ))}
        {discount.amount_cents > 0 && (
          <li>
            <span>
              Remise saga <span className={styles.quantity}>{discountNote(discount)}</span>
            </span>{" "}
            <span className={styles.amount}>−{formatCents(discount.amount_cents)}</span>
          </li>
        )}
      </ul>

      <details className={styles.details}>
        <summary>détails</summary>
        <div className={styles.detailsBody}>
          <ul className={styles.readings}>
            {quote.lines.map((line, index) => (
              <li key={index}>
                {`« ${line.title} »`} lu comme {filmLabel(line.film)}, confiance {formatPercent(line.confidence)}
                {line.confidence < LOW_CONFIDENCE && <span className={styles.badge}>à vérifier</span>}
              </li>
            ))}
          </ul>
          <Judge judge={quote.judge} />
          <UsageLine usage={quote.usage} />
        </div>
      </details>
    </section>
  );
}

/** What the line was recognized as; an unlisted film has no name of its own, so the title as written. */
function recognized({ film, title }: QuoteLine): string {
  return film === "other" ? title : filmLabel(film);
}

function discountNote({ distinct_volumes, percent }: Discount): string {
  return `${distinct_volumes} volets, −${formatPercent(percent / 100)}`;
}

function Judge({ judge }: { judge: JudgeOutcome }) {
  return (
    <div className={styles.judge}>
      <p>
        Avant de chiffrer, un juge a vérifié la lecture, une courte question par fait{judge.attempts > 1 && ` (relu ${judge.attempts} fois)`}.
        La moins bonne réponse fait le score : {formatPercent(judge.score)}, pour un seuil de {formatPercent(judge.threshold)}.
        Le prix, lui, est calculé par le code, à partir du catalogue.
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
  );
}
