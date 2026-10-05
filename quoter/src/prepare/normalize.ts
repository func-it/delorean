/**
 * Puts a cart's text in one form before any model reads it: LF line ends,
 * nothing invisible but `\n`, `\t` and the joiners, Unicode NFC, no blanks at
 * either end. Two carts that look alike reach the models alike.
 *
 * What goes is what a reader cannot see but a model reads: control
 * characters, and the format characters (Unicode Cf) — zero-width spaces,
 * which split a word to slip it past a reader; bidirectional overrides, which
 * show text in another order than it is read; tag characters, which spell
 * ASCII no one sees. An instruction hidden there would reach the models and no
 * reviewer. The zero-width joiner and non-joiner stay: emoji (👨‍👩‍👧) and
 * some scripts (Persian) are spelt with them. Neither stays any character of
 * `HIDDEN`, which draws nothing either without being a format character.
 */
export function normalize(text: string): string {
  // a lone surrogate, which JSON lets through, reads as U+FFFD
  const visible = withoutHidden(text.toWellFormed().replaceAll('\r\n', '\n').replace(INVISIBLE, ''));
  // NFC once they are gone: one between a letter and its accent would otherwise keep them apart
  return visible.normalize('NFC').trim();
}

/** Control characters but `\n` and `\t`, format characters but U+200C and U+200D. */
const INVISIBLE = /[^\P{Cc}\n\t]|[^\P{Cf}\u{200C}\u{200D}]/gu;

/**
 * The characters that draw nothing and are not format characters, so that they can hide text from a
 * reader as the zero-width ones do: a grapheme joiner, the fillers of Hangul and Khmer, Mongolian variation
 * selectors, the blank braille pattern, the variation selectors (and their supplement). An explicit table,
 * not a Unicode property: runtimes' Unicode versions differ.
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f], // combining grapheme joiner
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian free variation selectors, and the vowel separator
  [0x2800, 0x2800], // blank braille pattern
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0100, 0xe01ef], // variation selectors supplement
];

function withoutHidden(text: string): string {
  let kept = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (!HIDDEN.some(([from, to]) => code >= from && code <= to)) kept += character;
  }
  return kept;
}
