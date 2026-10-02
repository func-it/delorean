import Link from "next/link";

import type { Problem } from "@/lib/contract";
import { explainProblem } from "@/lib/rejections";

import styles from "./Rejection.module.css";
import { UsageLine } from "./UsageLine";

export function Rejection({ problem }: { problem: Problem }) {
  const { title, detail, facts, showReference, relogin } = explainProblem(problem);

  return (
    <section
      className={styles.rejection}
      data-fault={showReference ? "ours" : "cart"}
      aria-labelledby="rejection-title"
    >
      <h2 id="rejection-title" className={styles.title}>
        {title}
      </h2>
      <p>{detail}</p>
      {facts.length > 0 && (
        <ul className={styles.facts}>
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {relogin && (
        <p>
          <Link href="/login" className="button button-primary">
            Se reconnecter
          </Link>
        </p>
      )}
      {showReference && problem.request_id && (
        <p className={styles.reference}>
          Référence de la demande : <code>{problem.request_id}</code>
        </p>
      )}
      {problem.usage && <UsageLine usage={problem.usage} />}
    </section>
  );
}
