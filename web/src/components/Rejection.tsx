import { explainProblem } from "@/lib/rejections";
import type { Problem } from "@/lib/contract";

import styles from "./Rejection.module.css";
import { UsageLine } from "./UsageLine";

/** One sentence. The facts behind it, when there are any, stay behind « détails ». */
export function Rejection({ problem }: { problem: Problem }) {
  const { message, facts, reference } = explainProblem(problem);
  const hasDetails = facts.length > 0 || reference !== undefined || problem.usage !== undefined;

  return (
    <section className={styles.rejection} aria-label="Refus">
      <p className={styles.message}>{message}</p>
      {hasDetails && (
        <details className={styles.details}>
          <summary>détails</summary>
          <div className={styles.detailsBody}>
            {facts.length > 0 && (
              <ul className={styles.facts}>
                {facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            )}
            {reference && (
              <p className={styles.reference}>
                Référence de la demande : <code>{reference}</code>
              </p>
            )}
            {problem.usage && <UsageLine usage={problem.usage} />}
          </div>
        </details>
      )}
    </section>
  );
}
