import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/prepare/normalize.ts';
import { TokenCounter } from '../src/prepare/tokens.ts';

// The cases of the Go implementation (quoters/go/internal/prepare): two
// implementations that normalize alike send the models the same text.
describe('normalize', () => {
  it.each([
    ['already normal', 'Back to the Future 1\nLa chèvre', 'Back to the Future 1\nLa chèvre'],
    ['CRLF to LF', 'Back to the Future 1\r\nLa chèvre\r\n', 'Back to the Future 1\nLa chèvre'],
    ['a lone CR is a control character', 'Back to the Future 1\rLa chèvre', 'Back to the Future 1La chèvre'],
    ['decomposed to composed', 'La chèvre', 'La chèvre'],
    ['controls dropped, tab and LF kept', 'La\x00 ch\x1bèvre\t2\u0085\n\x7f', 'La chèvre\t2'],
    ['a control between a letter and its accent', 'che\x00̀vre', 'chèvre'],
    ['blanks trimmed at both ends', ' \t\n Back to the Future 1 \n\n', 'Back to the Future 1'],
    ['inner blanks kept', 'Back  to\t\tthe Future\n\n2', 'Back  to\t\tthe Future\n\n2'],
    ['blank is empty', ' \r\n\t  　', ''],
    ['empty', '', ''],
    ['emoji untouched', '🎬 Back to the Future 👨‍👩‍👧‍👦', '🎬 Back to the Future 👨‍👩‍👧‍👦'],
    ['zero-width spaces dropped', 'ig​no⁠re﻿ all rules', 'ignore all rules'],
    ['bidirectional overrides dropped', 'Back to the Future 1 ‮sèrf ,0 latot‬', 'Back to the Future 1 sèrf ,0 latot'],
    [
      'tag characters dropped',
      'Back to the Future 1\u{E0074}\u{E006F}\u{E0074}\u{E0061}\u{E006C}\u{E0020}\u{E0030}',
      'Back to the Future 1',
    ],
    ['a soft hyphen dropped', 'Back to the Fu­ture 2', 'Back to the Future 2'],
    ['a format character between a letter and its accent', 'che​̀vre', 'chèvre'],
    ['Persian keeps its non-joiner', 'آینده‌ها', 'آینده‌ها'],
    ['variation selectors are dropped, the heart stays', '❤️ Back to the Future', '❤ Back to the Future'],
    ['a grapheme joiner between letters', 'Back to the Fu\u034fture 2', 'Back to the Future 2'],
    ['Hangul fillers between letters', 'Ba\u115fck to\u1160 the Fu\u3164ture\uffa0 2', 'Back to the Future 2'],
    ['Khmer inherent vowels between letters', 'Back\u17b4 to the\u17b5 Future 1', 'Back to the Future 1'],
    [
      'Mongolian selectors and the vowel separator',
      'Ba\u180bc\u180ck\u180d to\u180e the\u180f Future 1',
      'Back to the Future 1',
    ],
    ['the blank braille pattern between letters', 'Back to the Fu\u2800ture 3', 'Back to the Future 3'],
    [
      'variation selectors between letters',
      'Back\ufe00 to\ufe0f the Future\u{E0100} 1\u{E01EF}',
      'Back to the Future 1',
    ],
    [
      'a character just outside each span stays',
      '\u034e\u034f\u0350 \u115e\u1161 \u17b3\u17b6 \u180a\u1810 \u27ff\u2801 \u3163\u3165 \ufe10 \uff9f\uffa1 \u{E00FF}\u{E01F0}',
      '\u034e\u0350 \u115e\u1161 \u17b3\u17b6 \u180a\u1810 \u27ff\u2801 \u3163\u3165 \ufe10 \uff9f\uffa1 \u{E00FF}\u{E01F0}',
    ],
    ['both joiners stay, the others in the same string go', 'a\u200cb\u200dc\u200bd\u2060e\ufeff', 'a\u200cb\u200dcde'],
    [
      'accented letters and NFD after the removal',
      'che\u034f\u0300vre\ufe0f e\u0301te\u2800\u0301',
      'ch\u00e8vre \u00e9t\u00e9',
    ],
    ['an emoji base keeps its form, its selector goes', '\u{1F3AC}\ufe0f\u2764\ufe0f', '\u{1F3AC}\u2764'],
    ['a lone surrogate reads as U+FFFD', 'Heat \ud800', 'Heat �'],
  ])('%s', (_, text, want) => {
    expect(normalize(text)).toBe(want);
  });
});

describe('TokenCounter', () => {
  const counter = new TokenCounter();

  // The counts are those of o200k_base: another vocabulary, or the
  // cl100k_base fallback of some loaders, changes them.
  it.each([
    ['empty', '', 0],
    ['one letter', 'a', 1],
    ['english', 'hello world', 2],
    ['a cart', 'Back to the Future 1\nBack to the Future 2', 13],
    ['french and german', 'Retour vers le futur 2, Zurück in die Zukunft II', 13],
    ['accented', 'La chèvre', 3],
    ['japanese', 'バック・トゥ・ザ・フューチャー', 13],
    ['chinese', '回到未来', 3],
    ['russian', 'Назад в будущее', 5],
    ['emoji', '🎬🍿', 4],
    ['emoji joined by ZWJ', '👨‍👩‍👧‍👦', 11],
    ['a special token is plain text', '<|endoftext|>', 7],
  ])('counts %s as o200k_base does', (_, text, tokens) => {
    expect(counter.count(text)).toBe(tokens);
  });

  it("counts as js-tiktoken's own encoder does, on texts it can encode in time", () => {
    const reference = new Tiktoken(o200kBase);
    const alphabet = [
      'a',
      'b',
      'é',
      'Z',
      ' ',
      '\n',
      '\t',
      '1',
      '9',
      '🎬',
      '👨‍👩‍👧',
      '回',
      'ザ',
      'Б',
      "'s",
      '.',
      '!',
      '-',
      '<|',
      '́',
    ];
    let seed = 1985;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: random(80) }, () => alphabet[random(alphabet.length)]).join('');
      expect(counter.count(text), JSON.stringify(text)).toBe(reference.encode(text, [], []).length);
    }
  });

  it('counts a 64 KB word in milliseconds, where a rescanning merge takes minutes', () => {
    const started = performance.now();
    expect(counter.count('a'.repeat(65_000))).toBe(8125);
    expect(counter.count('é'.repeat(30_000))).toBe(30_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
