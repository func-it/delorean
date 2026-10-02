package bench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/httpapi"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// Validate reads every case folder under base, offline, and lists what is
// wrong: a file that is not a case, an id that is not its file name, an
// empty note, an input or an expect off its folder's format, a film, a
// verdict, a check or a code no one knows. No problem, nil. The format of
// each folder is docs/architecture.md's.
func Validate(base string) ([]string, error) {
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, err
	}
	var problems []string
	seen := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(base, e.Name())
		check, ok := folders[e.Name()]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s: no subject reads this folder (%s)", dir, strings.Join(Folders(), ", ")))
			continue
		}
		seen[e.Name()] = true
		paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			problems = append(problems, dir+": no case")
		}
		for _, p := range paths {
			c, err := read(p)
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			for _, why := range append(envelope(c), check(c)...) {
				problems = append(problems, fmt.Sprintf("%s: %s", p, why))
			}
		}
	}
	for _, f := range Folders() {
		if !seen[f] {
			problems = append(problems, filepath.Join(base, f)+": missing")
		}
	}
	return problems, nil
}

// Folders are the case folders, sorted.
func Folders() []string {
	out := make([]string, 0, len(folders))
	for f := range folders {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// folders check each folder's input and expect, and say what is wrong.
var folders = map[string]func(Case) []string{
	"quote":    checkQuote,
	"guard":    checkGuard,
	"identify": checkIdentify,
	"reading":  checkReading,
	"judge":    checkJudge,
}

// envelope checks what every case carries: a note, and tags worth reading.
func envelope(c Case) []string {
	var out []string
	if strings.TrimSpace(c.Note) == "" {
		out = append(out, "no note: say which mistake the case guards against")
	}
	for i, t := range c.Tags {
		if strings.TrimSpace(t) == "" || slices.Contains(c.Tags[:i], t) {
			out = append(out, fmt.Sprintf("tag %q empty or repeated", t))
		}
	}
	return out
}

// part decodes a case's input or expect strictly, and says what is wrong.
func part(name string, raw json.RawMessage, v any) []string {
	if len(raw) == 0 {
		return []string{name + " missing"}
	}
	if err := strict(raw, v); err != nil {
		return []string{fmt.Sprintf("%s: %v", name, err)}
	}
	return nil
}

func blank(s string) bool { return strings.TrimSpace(s) == "" }

// checkFilms checks a {film: quantity} map.
func checkFilms(films map[cart.Film]int) []string {
	var out []string
	for f, n := range films {
		if !f.Valid() {
			out = append(out, fmt.Sprintf("film %q unknown (%s)", f, filmList()))
		}
		if n < 1 {
			out = append(out, fmt.Sprintf("film %s: quantity %d, at least 1", f, n))
		}
	}
	return out
}

func filmList() string {
	names := make([]string, len(cart.Films))
	for i, f := range cart.Films {
		names[i] = string(f)
	}
	return strings.Join(names, ", ")
}

// statusOf is the status a problem code comes with: the HTTP layer's own
// codes have theirs, and every other code is a cart a stage refused, 422.
// The codes themselves are the contract's (httpapi, generated from
// api/openapi.yaml).
func statusOf(code httpapi.ProblemCode) int {
	switch code {
	case httpapi.ProblemCodeMalformedRequest:
		return 400
	case httpapi.ProblemCodeNotFound:
		return 404
	case httpapi.ProblemCodeMethodNotAllowed:
		return 405
	case httpapi.ProblemCodePayloadTooLarge:
		return 413
	case httpapi.ProblemCodeInternal:
		return 500
	case httpapi.ProblemCodeEngineUnavailable:
		return 502
	}
	return 422
}

func checkQuote(c Case) []string {
	var in struct {
		Cart *string `json:"cart"`
	}
	var ex struct {
		Status     int                 `json:"status"`
		TotalCents *int                `json:"total_cents"`
		Films      map[cart.Film]int   `json:"films"`
		Code       httpapi.ProblemCode `json:"code"`
	}
	out := append(part("input", c.Input, &in), part("expect", c.Expect, &ex)...)
	if len(out) > 0 {
		return out
	}
	if in.Cart == nil {
		out = append(out, "input.cart missing")
	}
	switch {
	case ex.Status == 200:
		if ex.TotalCents == nil || *ex.TotalCents < 0 {
			out = append(out, "a 200 expects total_cents, at least 0")
		}
		if ex.Code != "" {
			out = append(out, "a 200 expects no code")
		}
		out = append(out, checkFilms(ex.Films)...)
	case ex.Code == "":
		out = append(out, fmt.Sprintf("status %d expects a code", ex.Status))
	case !ex.Code.Valid():
		out = append(out, fmt.Sprintf("code %q unknown to api/openapi.yaml", ex.Code))
	default:
		if want := statusOf(ex.Code); want != ex.Status {
			out = append(out, fmt.Sprintf("code %s comes with status %d, not %d", ex.Code, want, ex.Status))
		}
		if ex.TotalCents != nil || ex.Films != nil {
			out = append(out, "a refusal expects no total_cents nor films")
		}
	}
	return out
}

func checkGuard(c Case) []string {
	var in struct {
		Text string `json:"text"`
	}
	var ex struct {
		Verdict pipeline.Verdict `json:"verdict"`
	}
	out := append(part("input", c.Input, &in), part("expect", c.Expect, &ex)...)
	if len(out) > 0 {
		return out
	}
	if blank(in.Text) {
		out = append(out, "input.text empty: the guard never sees an empty cart")
	}
	if !slices.Contains(pipeline.Verdicts, ex.Verdict) {
		out = append(out, fmt.Sprintf("verdict %q unknown (valid, injection, invalid)", ex.Verdict))
	}
	return out
}

func checkIdentify(c Case) []string {
	var in struct {
		Title string `json:"title"`
	}
	var ex struct {
		Film cart.Film `json:"film"`
	}
	out := append(part("input", c.Input, &in), part("expect", c.Expect, &ex)...)
	if len(out) > 0 {
		return out
	}
	if blank(in.Title) {
		out = append(out, "input.title empty")
	}
	if !ex.Film.Valid() {
		out = append(out, fmt.Sprintf("film %q unknown (%s)", ex.Film, filmList()))
	}
	return out
}

func checkReading(c Case) []string {
	var in struct {
		Text string `json:"text"`
	}
	var ex struct {
		Films map[cart.Film]int `json:"films"`
	}
	out := append(part("input", c.Input, &in), part("expect", c.Expect, &ex)...)
	if len(out) > 0 {
		return out
	}
	if blank(in.Text) {
		out = append(out, "input.text empty")
	}
	if ex.Films == nil {
		out = append(out, "expect.films missing: {} when nothing is bought")
	}
	return append(out, checkFilms(ex.Films)...)
}

func checkJudge(c Case) []string {
	var in struct {
		Text  string      `json:"text"`
		Lines []cart.Line `json:"lines"`
	}
	var ex struct {
		Faithful *bool          `json:"faithful"`
		Check    pipeline.Check `json:"check"`
	}
	out := append(part("input", c.Input, &in), part("expect", c.Expect, &ex)...)
	if len(out) > 0 {
		return out
	}
	if blank(in.Text) {
		out = append(out, "input.text empty")
	}
	if len(in.Lines) == 0 {
		out = append(out, "input.lines empty: the judge never reads an empty reading")
	}
	for i, l := range in.Lines {
		if blank(l.Title) || l.Quantity < 1 || !l.Film.Valid() {
			out = append(out, fmt.Sprintf("line %d: a title, a quantity of at least 1 and a known film (%s)", i+1, filmList()))
		}
	}
	switch {
	case ex.Faithful == nil:
		out = append(out, "expect.faithful missing")
	case *ex.Faithful && ex.Check != "":
		out = append(out, "a faithful reading expects no failing check")
	}
	if ex.Check != "" && !ex.Check.Valid() {
		out = append(out, fmt.Sprintf("check %q unknown (asked, identity, quantity, missing)", ex.Check))
	}
	return out
}
