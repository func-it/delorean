"use client";

import { useRef, useState } from "react";

import { type BffResult, requestQuote } from "@/lib/bff-client";
import type { Quote } from "@/lib/contract";
import { formatCents } from "@/lib/format";
import type { Limits } from "@/lib/size";
import { explainProblem } from "@/lib/rejections";

import { CartForm } from "./CartForm";
import { DemoBanner } from "./DemoBanner";
import { QuoteResult } from "./QuoteResult";
import styles from "./QuoteWorkspace.module.css";
import { Rejection } from "./Rejection";

interface Props {
  limits?: Limits;
  /** What the quoter reads with: `fake` shows the demo banner and only the examples the fake can read. */
  engines?: "live" | "fake";
  /** The shop's prices, as a sentence written from the quoter's catalog; none when it did not answer. */
  prices?: string;
}

export function QuoteWorkspace({ limits, engines, prices }: Props) {
  const [cart, setCart] = useState("");
  const [outcome, setOutcome] = useState<BffResult<Quote>>();
  const [pending, setPending] = useState(false);
  /** Which submission the page waits for; an edit moves it on, so an answer to the old text is dropped. */
  const current = useRef(0);

  function changeCart(next: string) {
    current.current += 1;
    setCart(next);
    setOutcome(undefined);
    setPending(false);
  }

  async function submit() {
    if (pending) return;
    const mine = ++current.current;
    setPending(true);
    const result = await requestQuote(cart, limits?.maxBodyBytes);
    if (mine !== current.current) return;
    setOutcome(result);
    setPending(false);
  }

  return (
    <div className={styles.page}>
      {engines === "fake" && <DemoBanner />}
      <main className={styles.main}>
        <h1 className={styles.title}>Delorean</h1>
        <CartForm cart={cart} onCartChange={changeCart} onSubmit={submit} pending={pending} limits={limits} engines={engines} />
        <p role="status" className="visually-hidden">
          {announcement(pending, outcome)}
        </p>
        {outcome && (
          <div className={styles.outcome} aria-busy={pending}>
            {outcome.ok ? <QuoteResult quote={outcome.data} /> : <Rejection problem={outcome.problem} />}
          </div>
        )}
      </main>
      {prices && (
        <footer className={styles.footer}>
          <p>{prices}</p>
        </footer>
      )}
    </div>
  );
}

function announcement(pending: boolean, outcome?: BffResult<Quote>): string {
  if (pending) return "Calcul en cours…";
  if (!outcome) return "";
  return outcome.ok ? `Prix de la commande : ${formatCents(outcome.data.total_cents)}.` : explainProblem(outcome.problem).message;
}
