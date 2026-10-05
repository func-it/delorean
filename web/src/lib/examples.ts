export interface CartExample {
  id: string;
  label: string;
  cart: string;
}

/**
 * Three carts to start from, very discreetly: two of the brief
 * (`cases/quote/enonce-*.json`, kept in sync by a test) and one in several languages.
 */
export const EXAMPLES: CartExample[] = [
  {
    id: "enonce-1",
    label: "Les trois volets",
    cart: "Back to the Future 1\nBack to the Future 2\nBack to the Future 3",
  },
  {
    id: "enonce-5",
    label: "Avec un autre film",
    cart: "Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre",
  },
  {
    id: "multilingual",
    label: "Plusieurs langues",
    cart: "Zurück in die Zukunft\nRegreso al futuro II\nRitorno al futuro – Parte III\nLe Grand Bleu x 2",
  },
];
