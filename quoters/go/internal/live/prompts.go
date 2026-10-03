package live

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	files "github.com/func-it/delorean/prompts"
	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// promptSet is what the files say, read once and checked.
type promptSet struct {
	guard struct {
		Order decide.Question `json:"order"`
		Steer decide.Question `json:"steer"`
	}
	// parse is the reading of the parse and the recount; parseFilms the
	// parse's when it identifies the films too (Config.ParseIdentifies).
	parse, parseFilms readingPrompt
	identify          struct {
		Film decide.Question `json:"film"`
	}
	judge struct {
		Asked    decide.Question `json:"asked"`
		Identity decide.Question `json:"identity"`
		Missing  decide.Question `json:"missing"`
		// Films say what a title was identified as, in the judge's words.
		Films map[cart.Film]string `json:"films"`
	}
	// versions are each stage's: the first 8 hex digits of the SHA-256 of
	// its file's bytes. The recount reads parse.json, and shares its version.
	versions map[pipeline.Stage]string
}

// readingPrompt is a file a reader reads with: parse.json, parse-films.json.
type readingPrompt struct {
	Instruction string         `json:"instruction"`
	Schema      map[string]any `json:"schema"`
	// Message fences the customer's text in the user turn.
	Message struct {
		Before string `json:"before"`
		After  string `json:"after"`
	} `json:"message"`
	// Retry is the user turn of a reading again: Turn, its {findings} one
	// Finding line per failing check, with what the check means.
	Retry struct {
		Turn     string                    `json:"turn"`
		Finding  string                    `json:"finding"`
		Meanings map[pipeline.Check]string `json:"meanings"`
	} `json:"retry"`
	// version is the file's.
	version string
	// films says the schema asks each line its film.
	films bool
}

// prompts are what the repository's prompts/ say — every word the three
// implementations put to a model, embedded by a module of its own — or the
// program does not start: a test reads them.
var prompts = func() promptSet {
	p, err := readPrompts()
	if err != nil {
		panic("live: prompts/: " + err.Error())
	}
	return p
}()

func readPrompts() (promptSet, error) {
	var p promptSet
	p.versions = map[pipeline.Stage]string{}
	for _, f := range []struct {
		name   string
		into   any
		stages []pipeline.Stage
	}{
		{"guard.json", &p.guard, []pipeline.Stage{pipeline.StageGuard}},
		{"parse.json", &p.parse, []pipeline.Stage{pipeline.StageParse, pipeline.StageRecount}},
		{"parse-films.json", &p.parseFilms, nil},
		{"identify.json", &p.identify, []pipeline.Stage{pipeline.StageIdentify}},
		{"judge.json", &p.judge, []pipeline.Stage{pipeline.StageJudge}},
	} {
		b, err := files.Files.ReadFile(f.name)
		if err != nil {
			return p, err
		}
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		if err := dec.Decode(f.into); err != nil {
			return p, fmt.Errorf("%s: %w", f.name, err)
		}
		sum := sha256.Sum256(b)
		for _, s := range f.stages {
			p.versions[s] = hex.EncodeToString(sum[:4])
		}
		if r, ok := f.into.(*readingPrompt); ok {
			r.version = hex.EncodeToString(sum[:4])
		}
	}
	p.parseFilms.films = true
	return p, p.check()
}

// check holds the files to what the engines read of them: each question
// under its own key, of the kind the engine asks, with every option
// described.
func (p promptSet) check() error {
	var errs []error
	question := func(file, key string, q decide.Question, kind decide.Kind, options ...string) {
		got := slices.Sorted(maps.Keys(q.Criteria))
		slices.Sort(options)
		if q.Key != key || q.Kind != kind || q.Instructions == "" || !slices.Equal(got, options) {
			errs = append(errs, fmt.Errorf("%s: %q must be a %s question keyed %q, with instructions and criteria %v",
				file, key, kind, key, options))
		}
	}
	films := make([]string, len(cart.Films))
	for i, f := range cart.Films {
		films[i] = string(f)
	}
	question("guard.json", "order", p.guard.Order, decide.Noul, "true", "false")
	question("guard.json", "steer", p.guard.Steer, decide.Noul, "true", "false")
	question("identify.json", "film", p.identify.Film, decide.Choice, films...)
	question("judge.json", "asked", p.judge.Asked, decide.Noul, "true", "false")
	question("judge.json", "identity", p.judge.Identity, decide.Noul, "true", "false")
	question("judge.json", "missing", p.judge.Missing, decide.Noul, "true", "false")
	for _, f := range cart.Films {
		if p.judge.Films[f] == "" {
			errs = append(errs, fmt.Errorf("judge.json: films.%s has no name", f))
		}
	}
	for name, r := range map[string]readingPrompt{"parse.json": p.parse, "parse-films.json": p.parseFilms} {
		errs = append(errs, r.check(name)...)
	}
	return errors.Join(errs...)
}

// Version names what the engine of a stage asks — the file of prompts/ it
// reads — by a short hash: two bench runs, or two implementations, with the
// same version asked the same thing. Stages without a model have none.
func Version(s pipeline.Stage) string { return prompts.versions[s] }

// check holds a reading's file to what a reader reads of it.
func (r readingPrompt) check(file string) []error {
	var errs []error
	if r.Instruction == "" || r.Schema == nil || r.Message.Before == "" || r.Message.After == "" {
		errs = append(errs, fmt.Errorf("%s: an instruction, a schema and the message's fence are required", file))
	}
	if !strings.Contains(r.Retry.Turn, "{findings}") || !strings.Contains(r.Retry.Finding, "{check}") ||
		!strings.Contains(r.Retry.Finding, "{label}") || !strings.Contains(r.Retry.Finding, "{meaning}") {
		errs = append(errs, fmt.Errorf("%s: retry.turn must hold {findings}, retry.finding {check}, {label} and {meaning}", file))
	}
	for _, c := range []pipeline.Check{pipeline.CheckAsked, pipeline.CheckIdentity, pipeline.CheckMissing, pipeline.CheckCount} {
		if r.Retry.Meanings[c] == "" {
			errs = append(errs, fmt.Errorf("%s: retry.meanings.%s is missing", file, c))
		}
	}
	if r.films != strings.Contains(jsonOf(r.Schema), `"film"`) {
		errs = append(errs, fmt.Errorf("%s: the schema's films must have a film exactly when the file gives one", file))
	}
	return errs
}

// ParseVersion is the version of the parse's file: parse-films.json's when
// the parse identifies the films, parse.json's otherwise.
func ParseVersion(identifies bool) string {
	if identifies {
		return prompts.parseFilms.version
	}
	return prompts.parse.version
}

func jsonOf(v any) string {
	b, _ := json.Marshal(v) // plain data: it always marshals
	return string(b)
}
