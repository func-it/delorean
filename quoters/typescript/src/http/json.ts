/**
 * Where the first JSON value of a text ends, or why it does not: the text
 * stops inside it (`truncated`), or a character breaks its grammar
 * (`invalid`). JSON.parse says neither in words of its own, and lumps a
 * second value in with the first's errors; the quoter answers each case in
 * the words the docs give (docs/architecture.md).
 */
export type Scan = { end: number } | { error: 'truncated' | 'invalid' };

class Stop extends Error {
  readonly error: 'truncated' | 'invalid';
  constructor(error: 'truncated' | 'invalid') {
    super(error);
    this.error = error;
  }
}

/** JSON's whitespace: space, tab, line feed, carriage return. */
export function skipSpace(text: string, i: number): number {
  while (i < text.length && ' \t\n\r'.includes(text[i] ?? '')) i++;
  return i;
}

/**
 * The keys of the object that starts at `start`, in the order of the
 * document, a text `scanValue` has found to be one valid JSON object: a
 * parsed object lists the keys that look like an integer first, whatever
 * their place, and the quoters name the first unknown field of the document.
 */
export function objectKeys(text: string, start: number): string[] {
  const end = (at: number) => (scanValue(text, at) as { end: number }).end;
  const keys: string[] = [];
  let i = skipSpace(text, start) + 1;
  for (;;) {
    i = skipSpace(text, i);
    if (text[i] === '}') return keys;
    const keyEnd = end(i);
    keys.push(JSON.parse(text.slice(i, keyEnd)) as string);
    i = end(skipSpace(text, keyEnd) + 1);
    i = skipSpace(text, i);
    if (text[i] === ',') i++;
  }
}

export function scanValue(text: string, start: number): Scan {
  try {
    return { end: value(text, skipSpace(text, start)) };
  } catch (stop) {
    if (stop instanceof Stop) return { error: stop.error };
    throw stop;
  }
}

function value(text: string, i: number): number {
  if (i >= text.length) throw new Stop('truncated');
  const c = text[i];
  if (c === '{') return container(text, i, '}', true);
  if (c === '[') return container(text, i, ']', false);
  if (c === '"') return string(text, i);
  if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number(text, i);
  for (const literal of ['true', 'false', 'null']) {
    const given = text.slice(i, i + literal.length);
    if (given === literal) return i + literal.length;
    if (literal.startsWith(given) && i + given.length === text.length) throw new Stop('truncated');
  }
  throw new Stop('invalid');
}

function container(text: string, i: number, close: string, keyed: boolean): number {
  i = skipSpace(text, i + 1);
  if (i >= text.length) throw new Stop('truncated');
  if (text[i] === close) return i + 1;
  for (;;) {
    if (keyed) {
      if (text[i] !== '"') throw new Stop(i >= text.length ? 'truncated' : 'invalid');
      i = skipSpace(text, string(text, i));
      if (i >= text.length) throw new Stop('truncated');
      if (text[i] !== ':') throw new Stop('invalid');
      i = skipSpace(text, i + 1);
    }
    i = skipSpace(text, value(text, i));
    if (i >= text.length) throw new Stop('truncated');
    if (text[i] === close) return i + 1;
    if (text[i] !== ',') throw new Stop('invalid');
    i = skipSpace(text, i + 1);
    if (i >= text.length) throw new Stop('truncated');
  }
}

function string(text: string, i: number): number {
  for (i++; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) return i + 1;
    if (c < 0x20) throw new Stop('invalid');
    if (c === 0x5c) {
      i++;
      if (i >= text.length) break;
      const escaped = text[i] ?? '';
      if (escaped === 'u') {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Stop('invalid');
        if (hex.length < 4) break;
        i += 4;
      } else if (!'"\\/bfnrt'.includes(escaped)) {
        throw new Stop('invalid');
      }
    }
  }
  throw new Stop('truncated');
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_PREFIX = /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?\d*)?$/;

/** A number: its run of number characters must be one; cut short by the end of the text ("1.", "-"), it is truncated. */
function number(text: string, i: number): number {
  let end = i;
  while (end < text.length && '+-0123456789.eE'.includes(text[end] ?? '')) end++;
  const run = text.slice(i, end);
  if (NUMBER.test(run)) return end;
  throw new Stop(end === text.length && NUMBER_PREFIX.test(run) ? 'truncated' : 'invalid');
}
