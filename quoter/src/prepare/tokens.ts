import o200kBase from 'js-tiktoken/ranks/o200k_base';

/**
 * Counts tokens with the o200k_base BPE vocabulary, that of OpenAI's current
 * models, without network: js-tiktoken ships the ranks in its package. Jev's
 * tokenizer is not published; o200k_base is an estimate, and the margin
 * between the cart limit and Jev's 32k tokens per question covers its error.
 *
 * The merge is tiktoken's — the lowest-ranked adjacent pair first, the
 * leftmost on a tie — but kept in a heap instead of rescanned after each
 * merge. The counts are the same (test/tokens.test.ts holds them to
 * js-tiktoken's); the cost is not: the rescan is quadratic in the length of a
 * piece, and one 64 KB word would hold Node's single thread for minutes.
 */
export class TokenCounter {
  /** Each token's bytes, as a latin1 string, to its rank. */
  readonly #ranks = new Map<string, number>();
  readonly #pattern: RegExp;

  /** Decodes the vocabulary, which takes a few hundred milliseconds: build one counter and share it. */
  constructor(vocabulary: Vocabulary = o200kBase) {
    this.#pattern = new RegExp(vocabulary.pat_str, 'gu');
    // each line is "! <first rank> <token> <token>…", the tokens in base64
    for (const line of vocabulary.bpe_ranks.split('\n')) {
      const [, first, ...tokens] = line.split(' ');
      if (first === undefined) continue;
      const offset = Number.parseInt(first, 10);
      tokens.forEach((token, i) => this.#ranks.set(Buffer.from(token, 'base64').toString('latin1'), offset + i));
    }
  }

  /** How many tokens the vocabulary has, special tokens aside. */
  get ranks(): number {
    return this.#ranks.size;
  }

  /**
   * The number of tokens of text. A special token such as `<|endoftext|>`
   * counts as the plain text it is in a customer's cart.
   */
  count(text: string): number {
    let tokens = 0;
    for (const [piece] of text.matchAll(this.#pattern)) {
      tokens += this.#countPiece(Buffer.from(piece, 'utf8').toString('latin1'));
    }
    return tokens;
  }

  /** The tokens of one piece of the split, given as its UTF-8 bytes in a latin1 string. */
  #countPiece(bytes: string): number {
    const n = bytes.length;
    if (n < 2 || this.#ranks.has(bytes)) return 1;

    // The parts of the piece, each known by its first byte, in a linked
    // list; each part's pair is the bytes from its start to the end of the
    // next part. A rank is one byte string, so a pair in the heap whose rank
    // is no longer its part's is stale.
    const next = Int32Array.from({ length: n }, (_, i) => i + 1);
    const previous = Int32Array.from({ length: n }, (_, i) => i - 1);
    const pairRank = new Int32Array(n).fill(NONE);
    const heap = new MinHeap();
    const offer = (part: number) => {
      if (part < 0) return;
      const second = next[part] ?? n;
      const rank = second < n ? this.#ranks.get(bytes.slice(part, next[second] ?? n)) : undefined;
      pairRank[part] = rank ?? NONE;
      if (rank !== undefined) heap.push(rank * SPAN + part);
    };
    for (let part = 0; part < n - 1; part++) offer(part);

    let parts = n;
    for (let key = heap.pop(); key !== undefined; key = heap.pop()) {
      const part = key % SPAN;
      if (pairRank[part] !== (key - part) / SPAN) continue;
      const second = next[part] ?? n;
      const after = next[second] ?? n;
      next[part] = after;
      if (after < n) previous[after] = part;
      pairRank[second] = NONE;
      parts--;
      offer(previous[part] ?? -1);
      offer(part);
    }
    return parts;
  }
}

/** A BPE vocabulary as js-tiktoken ships it. */
export interface Vocabulary {
  pat_str: string;
  bpe_ranks: string;
}

/** No pair: the part is the last one, or its pair is no token. */
const NONE = -1;

/** A pair's key in the heap is rank × SPAN + start: the lowest rank first, the leftmost on a tie. */
const SPAN = 2 ** 32;

/** A binary min-heap of numbers. */
class MinHeap {
  readonly #items: number[] = [];

  push(item: number): void {
    const items = this.#items;
    let i = items.length;
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const above = items[parent] ?? -Infinity;
      if (above <= item) break;
      items[i] = above;
      i = parent;
    }
    items[i] = item;
  }

  pop(): number | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (last === undefined || items.length === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      const leftItem = items[left] ?? Infinity;
      const rightItem = items[right] ?? Infinity;
      const child = rightItem < leftItem ? right : left;
      const childItem = Math.min(leftItem, rightItem);
      if (childItem >= last) break;
      items[i] = childItem;
      i = child;
    }
    items[i] = last;
    return top;
  }
}
