/**
 * A cart's text in the one form the quoters read it in: the same as
 * `prepare.Normalize` of the Go quoter (and of the other two), so that two
 * texts the quoter reads alike are the same text here: LF line ends, nothing
 * invisible but `\n`, `\t` and the joiners, Unicode NFC, no blanks at either
 * end.
 *
 * What a reader cannot see but a model reads is dropped: the control
 * characters (Unicode Cc) but `\n` and `\t`, and the format characters (Cf)
 * but the zero-width non-joiner and joiner: zero-width spaces, bidirectional
 * overrides, the tag characters; and the few that draw nothing without being
 * format characters (`HIDDEN` below: fillers, variation selectors, the blank
 * braille pattern…).
 */
export function normalizeCart(text: string): string {
  const withoutCr = text.replaceAll("\r\n", "\n");
  let visible = "";
  for (const character of withoutCr) if (isVisible(character)) visible += character;
  // NFC once the invisible ones are gone: one between a letter and its accent would keep them apart
  return visible.normalize("NFC").trim();
}

const INVISIBLE = /^[\p{Cc}\p{Cf}]$/u;
const KEPT = new Set(["\n", "\t", "‌", "‍"]);

/**
 * Characters that draw nothing and can hide text from a reader, though they are not format characters:
 * the same table as the quoters' (not a Unicode property: runtimes disagree on its version).
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];

function isHidden(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return HIDDEN.some(([from, to]) => code >= from && code <= to);
}

function isVisible(character: string): boolean {
  return KEPT.has(character) || !(INVISIBLE.test(character) || isHidden(character));
}
