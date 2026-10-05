import type { FilmCounts, QuoteCase } from './cases.ts';
import type { Problem, Quote } from './contract.ts';

/** What a case looks at in an answer. */
export interface Outcome {
  status: number;
  code?: string;
  total_cents?: number;
  films?: FilmCounts;
}

/** How an outcome fares against a case. A check is absent when the case does not ask it. */
export interface Grade {
  passed: boolean;
  /** Priced, at the expected total. */
  price?: boolean;
  /** Priced, with the expected quantity per film. */
  films?: boolean;
  /** Refused, with the expected status and code. */
  rejection?: boolean;
  mismatches: string[];
}

/** Reads an answer whose body already conforms to the contract. */
export function outcomeOf(status: number, body: unknown): Outcome {
  if (status === 200) {
    const quote = body as Quote;
    return { status, total_cents: quote.total_cents, films: filmsOf(quote.lines) };
  }
  return { status, code: (body as Problem).code };
}

export function filmsOf(lines: Pick<Quote['lines'][number], 'film' | 'quantity'>[]): FilmCounts {
  const films: FilmCounts = {};
  for (const { film, quantity } of lines) films[film] = (films[film] ?? 0) + quantity;
  return films;
}

export function grade(expected: QuoteCase['expect'], actual: Outcome): Grade {
  const unexpected = `expected ${describeStatus(expected)}, got ${describeStatus(actual)}`;
  if ('code' in expected) {
    const refused = actual.status === expected.status && actual.code === expected.code;
    return refused ? { passed: true, rejection: true, mismatches: [] } : failedGrade(expected, unexpected);
  }
  if (actual.status !== 200) return failedGrade(expected, unexpected);

  const mismatches: string[] = [];
  const price = actual.total_cents === expected.total_cents;
  if (!price) {
    mismatches.push(`total_cents: expected ${expected.total_cents}, got ${actual.total_cents ?? 'none'}`);
  }
  if (!expected.films) return { passed: price, price, mismatches };
  const films = formatFilms(expected.films) === formatFilms(actual.films ?? {});
  if (!films) {
    mismatches.push(`films: expected ${formatFilms(expected.films)}, got ${formatFilms(actual.films ?? {})}`);
  }
  return { passed: price && films, price, films, mismatches };
}

/** Every check the case asks, failed for `reason`. */
export function failedGrade(expected: QuoteCase['expect'], reason: string): Grade {
  const checks = 'code' in expected ? { rejection: false } : { price: false, ...(expected.films && { films: false }) };
  return { passed: false, ...checks, mismatches: [reason] };
}

function describeStatus(outcome: { status: number; code?: string }): string {
  return outcome.code ? `${outcome.status} ${outcome.code}` : `${outcome.status}`;
}

/** A canonical rendering: equal counts render equal. */
function formatFilms(films: FilmCounts): string {
  const entries = Object.entries(films)
    .filter(([, quantity]) => quantity > 0)
    .sort(([x], [y]) => x.localeCompare(y));
  return `{${entries.map(([film, quantity]) => `${film}: ${quantity}`).join(', ')}}`;
}
