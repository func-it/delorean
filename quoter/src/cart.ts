/**
 * The vocabulary of a reading: the films the shop prices, and the lines a
 * customer's text is read into. Nothing here but what a value tells about
 * itself.
 */

/** The saga's volumes, in order, once: the position of a film here is its volume number. The ids of the API contract. */
export const SAGA = ['bttf_1', 'bttf_2', 'bttf_3'] as const;

/** What a title is identified as: a saga volume, or any other film. */
export type Film = (typeof SAGA)[number] | 'other';

/** Every possible identification, the saga volumes first, in order. */
export const FILMS: readonly Film[] = [...SAGA, 'other'];

export function isFilm(value: unknown): value is Film {
  return FILMS.includes(value as Film);
}

/** The saga volume of a film, 1 to 3, and 0 for any other film. */
export function volumeOf(film: Film): number {
  return (SAGA as readonly Film[]).indexOf(film) + 1;
}

/** Whether a film is a Back to the Future volume. */
export function inSaga(film: Film): boolean {
  return volumeOf(film) > 0;
}

/**
 * The most copies of one title a cart may ask, its mentions merged; above,
 * the cart is refused. No DVD shop would fill more, and every amount in cents
 * stays far from overflow.
 */
export const MAX_QUANTITY = 1000;

/** A film the customer asks to buy, as a reader reads it: the title as written, and how many copies. */
export interface Mention {
  title: string;
  quantity: number;
}

/** A mention once its title is identified. */
export interface Line extends Mention {
  film: Film;
  /** The calibrated confidence of the identification, 0 to 1. */
  confidence: number;
}
