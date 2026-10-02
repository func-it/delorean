"use client";

import { type KeyboardEvent, useRef } from "react";

import { EXAMPLES } from "@/lib/examples";

import styles from "./CartForm.module.css";

interface Props {
  cart: string;
  onCartChange: (cart: string) => void;
  onSubmit: () => void;
  pending: boolean;
}

export function CartForm({ cart, onCartChange, onSubmit, pending }: Props) {
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
      <h1 className={styles.title}>
        <label htmlFor="cart">Votre panier</label>
      </h1>
      <p id="cart-hint" className={styles.hint}>
        Écrivez-le comme vous voulez : une ligne par film, une phrase, plusieurs langues, une histoire. Nous le
        lisons, puis le code calcule le prix.
      </p>
      <textarea
        ref={textarea}
        id="cart"
        name="cart"
        className={`field ${styles.cart}`}
        value={cart}
        onChange={(event) => onCartChange(event.target.value)}
        onKeyDown={submitOnModEnter}
        rows={7}
        aria-describedby="cart-hint cart-shortcut"
      />

      <div className={styles.examples}>
        <h2 id="examples-title" className={styles.examplesTitle}>
          Partir d&apos;un exemple
        </h2>
        <ul className={styles.chips} aria-labelledby="examples-title">
          {EXAMPLES.map((example) => (
            <li key={example.id}>
              <button type="button" className="chip" onClick={() => pickExample(example.cart)}>
                {example.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending && <span className={styles.spinner} aria-hidden="true" />}
          {pending ? "Calcul en cours…" : "Calculer le prix"}
        </button>
        <p id="cart-shortcut" className={styles.shortcut}>
          ou <kbd>Ctrl</kbd> + <kbd>Entrée</kbd> (<kbd>⌘</kbd> + <kbd>Entrée</kbd> sur Mac)
        </p>
      </div>
    </form>
  );
}
