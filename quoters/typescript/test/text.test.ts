import { describe, expect, it } from 'vitest';
import { refusalOf } from '../src/pipeline/reading.ts';
import { titleKey, trimSpace } from '../src/text.ts';

// The key of a title, to the code point: Unicode's simple lower-casing of each
// code point on its own, no context rule (a final sigma stays σ) and no special
// casing (İ is i), the words split on the blanks of unicode.IsSpace and no
// others.
describe('titleKey', () => {
  it.each([
    ['  Back   TO\tthe Future  ', 'back to the future'],
    ['İSTANBUL', 'istanbul'],
    ['ΟΔΟΣ', 'οδοσ'],
    ['ΑΣ Σ', 'ασ σ'],
    ['Ὀδυσσεύς ΟΔΥΣΣΕΎΣ', 'ὀδυσσεύς οδυσσεύσ'],
    ['ẞ', 'ß'],
    ['K', 'k'],
    ['ǅ ǈ', 'ǆ ǉ'],
    ['ᾈ', 'ᾀ'],
    ['Ⅷ', 'ⅷ'],
    ['I', 'i'],
    ['日本語 ＡＢＣ', '日本語 ａｂｃ'],
  ])('keys %j as %j', (title, key) => {
    expect(titleKey(title)).toBe(key);
  });

  // a blank is what unicode.IsSpace says: U+0085 and U+00A0 are, U+FEFF and U+001F are not
  it.each([
    ['a\u0085b', 'a b'],
    ['a b', 'a b'],
    ['a b', 'a b'],
    ['a　b', 'a b'],
    ['a﻿b', 'a﻿b'],
    ['a\u001fb', 'a\u001fb'],
    ['\u0085a ', 'a'],
  ])('splits %j on blanks only: %j', (title, key) => {
    expect(titleKey(title)).toBe(key);
  });

  it('trims the same blanks', () => {
    expect(trimSpace('\u0085  Heat 　')).toBe('Heat');
    expect(trimSpace('﻿Heat\u001f')).toBe('﻿Heat\u001f');
  });
});

describe('a refusal that quotes a title', () => {
  // a detail quotes a title as JSON.stringify does: the quote, the backslash and the control characters escaped
  it('quotes it as JSON writes a string', () => {
    const refusal = refusalOf([{ title: 'Bac k "to" é\tFuture', quantity: 1001 }]);
    expect(refusal?.detail).toBe(
      '"Bac k \\"to\\" é\\tFuture" is asked in 1001 copies; a cart holds at most 1000 of a title.',
    );
  });
});
