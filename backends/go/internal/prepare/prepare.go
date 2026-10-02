// Package prepare readies a cart's text before any model reads it: one normal
// form, and its size in tokens.
package prepare

import (
	"fmt"
	"strings"
	"sync"
	"unicode"

	"github.com/pkoukk/tiktoken-go"
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
// would reach the models and no reviewer.
func visible(r rune) rune {
	switch {
	case r == '\n', r == '\t', r == zwnj, r == zwj:
		return r
	case unicode.IsControl(r), unicode.Is(unicode.Cf, r):
		return -1
	}
	return r
}

// Encoding is the BPE vocabulary tokens are counted with. Jev's tokenizer is
// not published; o200k_base, that of OpenAI's current models, is an
// estimate, and the margin between the cart limit and Jev's 32k tokens per
// question covers its error.
const Encoding = tiktoken.MODEL_O200K_BASE

// tiktoken-go downloads its vocabularies unless told otherwise, and holds its
// loader in a package variable: set it once, to the vocabularies compiled
// into the binary.
var offline sync.Once

// Counter counts tokens, without network.
type Counter struct {
	bpe *tiktoken.Tiktoken
}

// NewCounter loads the vocabulary, which takes a few hundred milliseconds:
// build one counter and share it, it is safe for concurrent use.
func NewCounter() (*Counter, error) {
	offline.Do(func() { tiktoken.SetBpeLoader(tiktokenloader.NewOfflineLoader()) })
	bpe, err := tiktoken.GetEncoding(Encoding)
	if err != nil {
		return nil, fmt.Errorf("tokenizer %s: %w", Encoding, err)
	}
	return &Counter{bpe: bpe}, nil
}

// Count is the number of tokens of text. A special token such as
// <|endoftext|> counts as the plain text it is in a customer's cart.
func (c *Counter) Count(text string) int {
	return len(c.bpe.EncodeOrdinary(text))
}
