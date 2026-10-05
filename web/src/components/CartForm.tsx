"use client";

import { type KeyboardEvent, useRef } from "react";

import { EXAMPLES } from "@/lib/examples";
import { formatCount } from "@/lib/format";
import { adviseSize, type Limits, type SizeAdvice } from "@/lib/size";

import styles from "./CartForm.module.css";

interface Props {
  cart: string;
  onCartChange: (cart: string) => void;
  onSubmit: () => void;
  pending: boolean;
  /** The quoters' limits: without them the form says nothing about the size. */
  limits?: Limits;
}

export function CartForm({ cart, onCartChange, onSubmit, pending, limits }: Props) {
  const advice: SizeAdvice = limits ? adviseSize(cart, limits) : { state: "ok" };
  const textarea = useRef<HTMLTextAreaElement>(null);

  function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function pickExample(example: string) {
    onCartChange(example);
    textarea.current?.focus();
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="cart" className={styles.label}>
        Votre panier
      </label>
      <textarea
        ref={textarea}
        id="cart"
        name="cart"
        className={`field ${styles.cart}`}
        value={cart}
        onChange={(event) => onCartChange(event.target.value)}
        onKeyDown={submitOnModEnter}
        rows={6}
        placeholder="Les films que vous achetez, comme vous voulez les écrire"
        aria-describedby={advice.state === "ok" ? undefined : "cart-size"}
      />
      {advice.state !== "ok" && (
        <p id="cart-size" className={styles.size} data-state={advice.state} role="status">
          {sizeSentence(advice)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={pending || advice.state === "too_big"}>
          {pending && <span className={styles.spinner} aria-hidden="true" />}
          {pending ? "Calcul en cours…" : "Calculer le prix"}
        </button>
        <ul className={styles.examples} aria-label="Exemples de paniers">
          {EXAMPLES.map((example) => (
            <li key={example.id}>
              <button type="button" className={styles.example} onClick={() => pickExample(example.cart)}>
                {example.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}

/** What the page says of a cart's size, in words a customer uses: characters, never tokens. */
function sizeSentence(advice: Exclude<SizeAdvice, { state: "ok" }>): string {
  switch (advice.state) {
    case "near":
      return `${formatCount(advice.characters)} caractères : vous approchez de la longueur maximale, environ ${formatCount(advice.approximateMax)} caractères.`;
    case "long":
      return `${formatCount(advice.characters)} caractères : votre panier est probablement trop long, gardez seulement les titres et les quantités.`;
    case "too_big":
      return `Votre panier dépasse ${formatCount(Math.round(advice.maxBodyBytes / 1024))}\u00a0Ko : raccourcissez-le pour pouvoir le calculer.`;
  }
}
