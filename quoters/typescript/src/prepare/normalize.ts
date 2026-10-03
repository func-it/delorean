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
 * some scripts (Persian) are spelt with them.
 */
export function normalize(text: string): string {
  return (
    text
      // a lone surrogate, which JSON lets through, reads as U+FFFD, as in Go
      .toWellFormed()
      .replaceAll('\r\n', '\n')
      .replace(INVISIBLE, '')
      // NFC once they are gone: one between a letter and its accent would
      // otherwise keep them apart
      .normalize('NFC')
      .trim()
  );
}

/** Control characters but `\n` and `\t`, format characters but U+200C and U+200D. */
const INVISIBLE = /[^\P{Cc}\n\t]|[^\P{Cf}\u{200C}\u{200D}]/gu;
