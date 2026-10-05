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
      />
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" disabled={pending}>
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
