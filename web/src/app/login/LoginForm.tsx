"use client";

import { useActionState } from "react";

import { login, type LoginState } from "@/app/actions";

import styles from "./login.module.css";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    // Validated on the server, so that the message is the same in every browser.
    <form action={formAction} className={styles.form} noValidate>
      <label htmlFor="username" className={styles.label}>
        Nom d&apos;utilisateur
      </label>
      <input
        id="username"
        name="username"
        className="field"
        defaultValue={state.username}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="marty.mcfly"
        required
        maxLength={64}
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? "username-error" : "username-rule"}
      />
      {state.error ? (
        <p id="username-error" className={styles.error} role="alert">
          {state.error}
        </p>
      ) : (
        <p id="username-rule" className={styles.hint}>
          De 1 à 64 caractères : lettres sans accent, chiffres, point, tiret, tiret bas ou @.
        </p>
      )}
      <button type="submit" className="button button-primary" disabled={pending}>
        {pending ? "Connexion…" : "Entrer"}
      </button>
    </form>
  );
}
