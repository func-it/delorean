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
 * overrides, the tag characters.
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

function isVisible(character: string): boolean {
  return KEPT.has(character) || !INVISIBLE.test(character);
}
