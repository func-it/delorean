/**
 * Titles compared the way every implementation compares them: what Go's
 * strings.TrimSpace, strings.Fields and strings.ToLower do, which is not
 * quite what JavaScript's trim, \s and toLowerCase do (U+0085 is a space to
 * Go, U+FEFF is not; Go lowers Σ to σ wherever it stands, and İ to i).
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
