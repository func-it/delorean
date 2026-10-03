"use client";

import { useState, useTransition } from "react";

import { type BffResult, requestQuote } from "@/lib/bff-client";
import type { Quote } from "@/lib/contract";
import { formatCents } from "@/lib/format";
import { explainProblem } from "@/lib/rejections";

import { CartForm } from "./CartForm";
import { Header } from "./Header";
import { PromoRules } from "./PromoRules";
import { QuoteResult } from "./QuoteResult";
import styles from "./QuoteWorkspace.module.css";
import { Rejection } from "./Rejection";
import { useCatalog } from "./useCatalog";

interface Props {
  username: string;
  /** Configured quoter names, the default first. */
  quoters: string[];
}

export function QuoteWorkspace({ username, quoters }: Props) {
  const [quoter, setQuoter] = useState(quoters[0]);
  const catalog = useCatalog(quoter);
  const [cart, setCart] = useState("");
  const [outcome, setOutcome] = useState<BffResult<Quote>>();
  const [pending, startTransition] = useTransition();

  function submit() {
    if (pending) return;
    startTransition(async () => {
      const result = await requestQuote(cart, quoter);
      startTransition(() => setOutcome(result));
    });
  }

  return (
    // One root element: a fragment of siblings can be reordered around the nodes Next keeps in <body>
    // when arriving from the login page.
    <div>
      <Header username={username} quoters={quoters} quoter={quoter} onQuoterChange={setQuoter} />
      <main className={styles.main}>
        <div className={styles.primary}>
          <CartForm cart={cart} onCartChange={setCart} onSubmit={submit} pending={pending} />
          <p role="status" className="visually-hidden">
            {announcement(pending, outcome)}
          </p>
          {outcome && (
            <div className={styles.outcome} aria-busy={pending}>
              {outcome.ok ? (
                <QuoteResult quote={outcome.data} catalog={catalog.status === "ready" ? catalog.catalog : undefined} />
              ) : (
                <Rejection problem={outcome.problem} />
              )}
            </div>
          )}
        </div>
        <PromoRules catalog={catalog} />
      </main>
      <footer className={styles.footer}>
        <p>Les modèles lisent votre texte, le code calcule le prix.</p>
      </footer>
    </div>
  );
}

function announcement(pending: boolean, outcome?: BffResult<Quote>): string {
  if (pending) return "Calcul en cours…";
  if (!outcome) return "";
  return outcome.ok
    ? `Devis prêt : ${formatCents(outcome.data.total_cents)} à payer.`
    : explainProblem(outcome.problem).title;
}
