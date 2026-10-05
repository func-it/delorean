"use client";

import { useState, useTransition } from "react";

import { type BffResult, requestQuote } from "@/lib/bff-client";
import type { Quote } from "@/lib/contract";
import { formatCents } from "@/lib/format";
import type { Limits } from "@/lib/size";
import { explainProblem } from "@/lib/rejections";

import { CartForm } from "./CartForm";
import { QuoteResult } from "./QuoteResult";
import styles from "./QuoteWorkspace.module.css";
import { Rejection } from "./Rejection";

export function QuoteWorkspace({ quoter, limits }: { quoter: string; limits?: Limits }) {
  const [cart, setCart] = useState("");
  const [outcome, setOutcome] = useState<BffResult<Quote>>();
  const [pending, startTransition] = useTransition();

  function submit() {
    if (pending) return;
    startTransition(async () => {
      const result = await requestQuote(cart, quoter, limits?.maxBodyBytes);
      startTransition(() => setOutcome(result));
    });
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.title}>Delorean</h1>
        <CartForm cart={cart} onCartChange={setCart} onSubmit={submit} pending={pending} limits={limits} />
        <p role="status" className="visually-hidden">
          {announcement(pending, outcome)}
        </p>
        {outcome && (
          <div className={styles.outcome} aria-busy={pending}>
            {outcome.ok ? <QuoteResult quote={outcome.data} /> : <Rejection problem={outcome.problem} />}
          </div>
        )}
      </main>
      <footer className={styles.footer}>
        <p>
          Retour vers le futur : 15 € le DVD, tout autre film : 20 €. Deux volets différents de la saga dans le panier :
          −10 % sur ses DVD, trois : −20 %.
        </p>
      </footer>
    </div>
  );
}

function announcement(pending: boolean, outcome?: BffResult<Quote>): string {
  if (pending) return "Calcul en cours…";
  if (!outcome) return "";
  return outcome.ok ? `Prix de la commande : ${formatCents(outcome.data.total_cents)}.` : explainProblem(outcome.problem).message;
}
