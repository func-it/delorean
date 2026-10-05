// Package prepare readies a cart's text before any model reads it: one normal
// form, and its size in tokens.
package prepare

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/dlclark/regexp2"
	tiktokenloader "github.com/pkoukk/tiktoken-go-loader"
	"golang.org/x/text/unicode/norm"
)

// Normalize puts text in one form: LF line ends, nothing invisible but \n,
// \t and the joiners, Unicode NFC, no blanks at either end. Two carts that
// look alike reach the models alike.
func Normalize(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.Map(visible, text)
	// NFC once they are gone: one between a letter and its accent would
	// otherwise keep them apart
	text = norm.NFC.String(text)
	return strings.TrimSpace(text)
}

const (
	zwnj = '‌' // zero-width non-joiner, part of how Persian is spelt
	zwj  = '‍' // zero-width joiner, which builds 👨‍👩‍👧 and some scripts' letters
)

// visible drops what a reader cannot see but a model reads: control
// characters but \n and \t, and the format characters (Unicode Cf) but the
// joiners — zero-width spaces, which split a word to slip it past a reader;
// bidirectional overrides, which show text in another order than it is read;
// tag characters, which spell ASCII no one sees: an instruction hidden there
// would reach the models and no reviewer — and the characters of invisible.
func visible(r rune) rune {
	switch {
	case r == '\n', r == '\t', r == zwnj, r == zwj:
		return r
	case unicode.IsControl(r), unicode.Is(unicode.Cf, r), isInvisible(r):
		return -1
	}
	return r
}

// invisible are the characters that draw nothing and are not format
// characters, so that they can hide text from a reader as the zero-width
// ones do: a grapheme joiner, the fillers of Hangul and Khmer, Mongolian
// variation selectors, the blank braille pattern, the variation selectors
// (and their supplement). An explicit table, the same in the three quoters:
// the runtimes' Unicode versions differ, and a property would too.
var invisible = [...][2]rune{
	{0x034F, 0x034F},   // combining grapheme joiner
	{0x115F, 0x1160},   // Hangul choseong and jungseong fillers
	{0x17B4, 0x17B5},   // Khmer inherent vowels
	{0x180B, 0x180F},   // Mongolian free variation selectors, and the vowel separator
	{0x2800, 0x2800},   // blank braille pattern
	{0x3164, 0x3164},   // Hangul filler
	{0xFE00, 0xFE0F},   // variation selectors
	{0xFFA0, 0xFFA0},   // halfwidth Hangul filler
	{0xE0100, 0xE01EF}, // variation selectors supplement
}

func isInvisible(r rune) bool {
	for _, span := range invisible {
		if r >= span[0] && r <= span[1] {
			return true
		}
	}
	return false
}

// Encoding is the BPE vocabulary tokens are counted with. Jev's tokenizer is
// not published; o200k_base, that of OpenAI's current models, is an
// estimate, and the margin between the cart limit and Jev's 32k tokens per
// question covers its error.
const Encoding = "o200k_base"

// o200k_base as tiktoken-go v0.1.8 defines it (encoding.go): the pattern a
// text is split into pieces by, and the file of its ranks, which
// tiktoken-go-loader embeds and finds by name. tiktoken-go's own count
// merges a piece in quadratic time — seconds for a 64 KB word, before the
// cart is even refused — so Count merges on its own, and a test holds it to
// tiktoken-go's counts.
const (
	o200kPattern = `[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?` +
		`|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?` +
		`|\p{N}{1,3}` +
		`| ?[^\s\p{L}\p{N}]+[\r\n/]*` +
		`|\s*[\r\n]+` +
		`|\s+(?!\S)` +
		`|\s+`
	o200kRanks = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
)

// Counter counts tokens, without network.
type Counter struct {
	split *regexp2.Regexp
	ranks map[string]int
}

// NewCounter loads the vocabulary, which takes a few hundred milliseconds:
// build one counter and share it, it is safe for concurrent use.
func NewCounter() (*Counter, error) {
	ranks, err := tiktokenloader.NewOfflineLoader().LoadTiktokenBpe(o200kRanks)
	if err != nil {
		return nil, fmt.Errorf("tokenizer %s: %w", Encoding, err)
	}
	split, err := regexp2.Compile(o200kPattern, regexp2.None)
	if err != nil {
		return nil, fmt.Errorf("tokenizer %s: %w", Encoding, err)
	}
	return &Counter{split: split, ranks: ranks}, nil
}

// Ranks is the size of the vocabulary: the number of its tokens.
func (c *Counter) Ranks() int { return len(c.ranks) }

// Count is the number of tokens of text. A special token such as
// <|endoftext|> counts as the plain text it is in a customer's cart.
func (c *Counter) Count(text string) int {
	n := 0
	// regexp2 fails a match only past its timeout, and has none
	m, _ := c.split.FindStringMatch(text)
	for m != nil {
		n += c.tokens(m.String())
		m, _ = c.split.FindNextMatch(m)
	}
	return n
}

// tokens is how many tokens BPE makes of one piece. It merges as tiktoken
// does — the adjacent pair of lowest rank first, the leftmost of equal ranks,
// until no pair is a token — but keeps the pairs in a heap over a linked
// list of parts, where tiktoken scans them all after each merge: O(n log n)
// instead of O(n²).
func (c *Counter) tokens(piece string) int {
	n := len(piece)
	if _, ok := c.ranks[piece]; ok || n < 2 {
		return 1
	}
	// The parts, by the index of their first byte: the next part's, n after
	// the last; the previous part's, -1 before the first; the rank of the
	// token a part makes with the next, -1 if none. A piece is a cart's at
	// most, far under 2³¹ bytes.
	next, prev, rank := make([]int32, n), make([]int32, n), make([]int32, n)
	for i := range n {
		next[i], prev[i] = int32(i+1), int32(i-1)
	}
	h := make(pairs, 0, n)
	// pair queues the part at i with the next one, if together they are a
	// token. A token has one rank and a part only grows: a queued pair whose
	// rank is no longer its first part's is stale.
	pair := func(i int32) {
		rank[i] = -1
		if j := next[i]; int(j) < n {
			if r, ok := c.ranks[piece[i:next[j]]]; ok {
				rank[i] = int32(r)
				h.push(uint64(r)<<32 | uint64(i))
			}
		}
	}
	for i := range int32(n) {
		pair(i)
	}
	parts := n
	for len(h) > 0 {
		top := h.pop()
		i, r := int32(top&(1<<32-1)), int32(top>>32)
		if rank[i] != r {
			continue // its parts have merged since it was queued
		}
		j := next[i]
		rank[j] = -1 // merged into i: its own pair is stale too
		next[i] = next[j]
		if int(next[j]) < n {
			prev[next[j]] = i
		}
		parts--
		pair(i)
		if prev[i] >= 0 {
			pair(prev[i])
		}
	}
	return parts
}

// pairs is a binary heap of queued pairs, each a token's rank above its
// first part's start: lowest rank first and, of equal ranks, the leftmost,
// the order tiktoken merges in. It is typed, not container/heap's, which
// allocates for each pair.
type pairs []uint64

func (h *pairs) push(p uint64) {
	*h = append(*h, p)
	q := *h
	for i := len(q) - 1; i > 0; {
		up := (i - 1) / 2
		if q[up] <= q[i] {
			break
		}
		q[i], q[up] = q[up], q[i]
		i = up
	}
}

func (h *pairs) pop() uint64 {
	q := *h
	top, last := q[0], len(q)-1
	q[0] = q[last]
	q = q[:last]
	for i := 0; ; {
		least, l, r := i, 2*i+1, 2*i+2
		if l < last && q[l] < q[least] {
			least = l
		}
		if r < last && q[r] < q[least] {
			least = r
		}
		if least == i {
			break
		}
		q[i], q[least] = q[least], q[i]
		i = least
	}
	*h = q
	return top
}
