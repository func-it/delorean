import { FILMS, MAX_QUANTITY, isFilm, type Film, type Line, type Mention } from '../cart.ts';
import { titleKey, trimSpace } from '../text.ts';
import { EngineError, type Finding, type GuardAnswers, type Identification } from './ports.ts';
import { Rejection, type GuardVerdict, type Verdict } from './rejection.ts';

/**
 * The rules the pipeline applies to what engines answer. Each one refuses an
 * answer outside the engine's contract as an EngineError: dropping or
 * clamping it would price a cart the customer did not write.
 */

/** Whether x is a probability, 0 to 1. NaN is not. */
export function isUnit(x: unknown): x is number {
  return typeof x === 'number' && x >= 0 && x <= 1;
}

/**
 * The guard's verdict, made of its two answers: injection = steer,
 * valid = (1 − steer) × order, invalid = (1 − steer) × (1 − order). The
 * verdict is the likeliest, its confidence its probability; a tie goes to
 * the refusal, injection before invalid.
 */
export function verdictOf({ order, steer }: GuardAnswers): GuardVerdict {
  if (!isUnit(order) || !isUnit(steer)) {
    throw new EngineError(`guard: answers out of [0, 1]: order ${order}, steer ${steer}`);
  }
  const probabilities: Record<Verdict, number> = {
    injection: steer,
    invalid: (1 - steer) * (1 - order),
    valid: (1 - steer) * order,
  };
  const verdict = (['injection', 'invalid', 'valid'] as const).reduce((best, v) =>
    probabilities[v] > probabilities[best] ? v : best,
  );
  return { verdict, confidence: probabilities[verdict], probabilities, questions: { order, steer } };
}

/**
 * How the pipeline takes a reader's reading: it adds up the mentions of one
 * title, whatever its case and spacing, under its first spelling and in the
 * order of the text. A mention without a title, or with a quantity that is
 * not an integer of at least 1, is out of the reader's contract.
 */
export function merge(mentions: readonly Mention[]): Mention[] {
  const merged = new Map<string, Mention>();
  for (const m of mentions) {
    const title = trimSpace(m.title);
    if (title === '') throw new EngineError('a mention has no title');
    if (!Number.isInteger(m.quantity) || m.quantity < 1) {
      throw new EngineError(`${JSON.stringify(title)}: quantity ${m.quantity} is not an integer of at least 1`);
    }
    const key = titleKey(title);
    const line = merged.get(key) ?? { title, quantity: 0 };
    // a sum past 2^53 loses precision, never its size: it is refused all the same
    line.quantity += m.quantity;
    merged.set(key, line);
  }
  return [...merged.values()];
}

/**
 * Why a merged reading of the parser is no cart to price: no film
 * (no_film), or a title asked in more than MAX_QUANTITY copies
 * (quantity_too_large). Undefined for a reading to judge.
 */
export function refusalOf(mentions: readonly Mention[]): Rejection | undefined {
  const over = mentions.find((m) => m.quantity > MAX_QUANTITY);
  if (over) {
    return new Rejection(
      'quantity_too_large',
      `${JSON.stringify(over.title)} is asked in ${over.quantity} copies; a cart holds at most ${MAX_QUANTITY} of a title.`,
      { copies: { title: over.title, count: over.quantity, max: MAX_QUANTITY } },
    );
  }
  if (mentions.length === 0) return new Rejection('no_film', 'The text names no film to buy.');
  return undefined;
}

/**
 * The identifications of one request, by title: across the readings of a
 * request, a title is identified once.
 */
export class Identifications {
  readonly #byKey = new Map<string, Identification>();

  /**
   * The titles of the readings to put to Jev: those not identified yet,
   * distinct by their merge key, in the order they come.
   */
  unknown(...readings: (readonly Mention[])[]): string[] {
    const titles = new Map<string, string>();
    for (const { title } of readings.flat()) {
      const key = titleKey(title);
      if (!this.#byKey.has(key) && !titles.has(key)) titles.set(key, title);
    }
    return [...titles.values()];
  }

  /**
   * Keeps an identifier's answers, given in the order of `titles`. A missing
   * identification, or one with a film or a confidence out of the contract,
   * is an EngineError.
   */
  learn(titles: readonly string[], identifications: readonly Identification[]): void {
    if (identifications.length !== titles.length) {
      throw new EngineError(`${identifications.length} identifications for ${titles.length} titles`);
    }
    titles.forEach((title, i) => {
      const id = identifications[i];
      if (!id || !isFilm(id.film) || !isUnit(id.confidence)) {
        throw new EngineError(`${JSON.stringify(title)} identified as ${JSON.stringify(id)}`);
      }
      this.#byKey.set(titleKey(title), { film: id.film, confidence: id.confidence });
    });
  }

  /** Each mention of `reading` with the film and the confidence Jev gave its title. */
  lines(reading: readonly Mention[]): Line[] {
    return reading.map((m) => {
      const id = this.#byKey.get(titleKey(m.title));
      if (!id) throw new Error(`${JSON.stringify(m.title)} was never identified`);
      return { ...m, film: id.film, confidence: id.confidence };
    });
  }
}

/** What makes two readings the same to the judge: their lines' titles, quantities and films, in any order. */
export function readingKey(lines: readonly Line[]): string {
  return lines
    .map((l) => JSON.stringify([l.title, l.quantity, l.film]))
    .sort()
    .join('\n');
}

/**
 * The count checks: for each film either reading has, in the order of
 * FILMS, whether both give it the same number of copies — every film
 * outside the saga counted together, as the price is.
 */
export function countFindings(read: readonly Line[], recounted: readonly Line[]): Finding[] {
  const copies = (lines: readonly Line[], film: Film) =>
    lines.filter((l) => l.film === film).reduce((total, l) => total + l.quantity, 0);
  return FILMS.flatMap((film) => {
    const r = copies(read, film);
    const c = copies(recounted, film);
    if (r === 0 && c === 0) return [];
    return [{ check: 'count' as const, label: `${film}: ${r} read, ${c} recounted`, score: r === c ? 1 : 0 }];
  });
}

/** Refuses judge findings out of the contract: a check the judge does not put, a score that is not a probability. */
export function checkFindings(findings: readonly Finding[]): void {
  for (const f of findings) {
    if (!['asked', 'identity', 'missing'].includes(f.check) || !isUnit(f.score)) {
      throw new EngineError(`judge: check ${JSON.stringify(f.check)} scored ${f.score}`);
    }
  }
}
