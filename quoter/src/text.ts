/**
 * Titles compared by the blanks of Unicode's White_Space (the set of Go's
 * unicode.IsSpace) and a simple, context-free lower-casing, which is not quite
 * what JavaScript's trim, \s and toLowerCase do (U+0085 is a space here,
 * U+FEFF is not; Σ lowers to σ wherever it stands, and İ to i).
 */

const SPACE = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const EDGES = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, 'gu');
const RUNS = new RegExp(`[${SPACE}]+`, 'gu');

/** The text without blanks at either end. */
export function trimSpace(text: string): string {
  return text.replace(EDGES, '');
}

/** The text lowered letter by letter, its blanks trimmed and every run of them made one space. */
export function titleKey(title: string): string {
  const lowered = Array.from(trimSpace(title), (c) => (c === 'İ' ? 'i' : c.toLowerCase())).join('');
  return lowered.replace(RUNS, ' ');
}
