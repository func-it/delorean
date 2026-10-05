// Package jsonx writes JSON as every quoter writes it, as JSON.stringify does
// (docs/architecture.md, Identical quoters): compact, `<`, `>` and `&` as
// themselves, U+2028 and U+2029 as themselves, no trailing newline. Bodies,
// trace attributes and the requests a trace shows all go through it.
package jsonx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Marshal is json.Marshal, written as JSON.stringify writes.
func Marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return rawSeparators(bytes.TrimSuffix(b.Bytes(), []byte("\n"))), nil
}

// rawSeparators writes U+2028 and U+2029 as themselves: encoding/json always
// escapes them, for JavaScript embedded in HTML.
func rawSeparators(b []byte) []byte {
	if !bytes.Contains(b, []byte(`\u202`)) {
		return b
	}
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		if b[i] != '\\' || i+1 == len(b) {
			out = append(out, b[i])
			continue
		}
		// an escape: \\ is one, so a \u202x after it is text, not an escape
		if s := b[i+1:]; len(s) >= 5 && (string(s[:5]) == "u2028" || string(s[:5]) == "u2029") {
			out = utf8.AppendRune(out, rune(0x2020+int(s[4]-'0')))
			i += 5
			continue
		}
		out = append(out, b[i], b[i+1])
		i++
	}
	return out
}

// Quote is s as a JSON string — what JSON.stringify writes, and Python's
// json.dumps with ensure_ascii off: only the quote, the backslash and the
// control characters are escaped. encoding/json escapes more (<, >, &, U+2028,
// U+2029), and the three implementations must send the same state.
func Quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
