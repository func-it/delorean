export interface CartExample {
  id: string;
  label: string;
  cart: string;
  /** The fake engines of the demo mode read it right: only those are offered then. */
  fake: boolean;
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
    fake: true,
  },
  {
    id: "enonce-5",
    label: "Avec un autre film",
    cart: "Back to the Future 1\nBack to the Future 2\nBack to the Future 3\nLa chèvre",
    fake: true,
  },
  {
    id: "multilingual",
    label: "Plusieurs langues",
    cart: "Zurück in die Zukunft\nRegreso al futuro II\nRitorno al futuro – Parte III\nLe Grand Bleu x 2",
    fake: false,
  },
];

/** The examples to offer: on the fake engines of the demo mode, only those they can read. */
export function examplesFor(engines: "live" | "fake" | undefined): CartExample[] {
  return engines === "fake" ? EXAMPLES.filter((example) => example.fake) : EXAMPLES;
}
