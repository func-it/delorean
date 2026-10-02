import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";

import { LoginForm } from "./LoginForm";
import styles from "./login.module.css";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage() {
  if (await getSession()) redirect("/");

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.brand}>Delorean</p>
        <h1 className={styles.title}>Bienvenue au vidéoclub</h1>
        <p className={styles.lead}>Choisissez un nom pour composer votre panier.</p>
        <LoginForm />
        <p className={styles.finePrint}>
          Une identification, pas une authentification : aucun mot de passe, n&apos;importe qui peut prendre
          n&apos;importe quel nom. Il sert seulement à regrouper vos demandes dans nos traces.
        </p>
      </div>
    </main>
  );
}
