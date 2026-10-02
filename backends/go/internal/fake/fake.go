// Package fake holds the engines of ENGINES=fake: deterministic stand-ins for
// Jev and the LLM, for end-to-end tests without OpenRouter, never in
// production. Their rules are part of the test contract and the same in every
// implementation (docs/architecture.md, "Moteurs factices").
package fake

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// Lines of a cart that drive the fakes instead of naming films.
const (
	// Unfaithful, a line of its own, fails the judge's missing check.
	Unfaithful = "#fake:unfaithful"
	// EngineDown, a line of its own, fails the parse as an engine fails.
	EngineDown = "#fake:engine_down"
	directive  = "#fake:"
)

// New returns the fake engines.
func New() pipeline.Engines {
	return pipeline.Engines{Name: "fake", Guard: Guard{}, Parser: Parser{}, Identifier: Identifier{}, Judge: Judge{}}
}

// usage is the same for every fake stage: one call, free.
func usage() pipeline.Usage {
	return pipeline.Usage{Engine: "fake", Calls: 1}
}

// Guard holds injection a text with one of injectionMarks in any case,
// invalid one with no run of three letters, and valid anything else.
type Guard struct{}

var (
	injectionMarks = []string{"ignore", "disregard", "oublie", "instruction", "system prompt", "<script", "drop table"}
	threeLetters   = regexp.MustCompile(`\p{L}{3}`)
)

func (Guard) Check(_ context.Context, text string) (pipeline.GuardVerdict, pipeline.Usage, error) {
	lower := strings.ToLower(text)
	verdict := pipeline.Valid
	switch {
	case slices.ContainsFunc(injectionMarks, func(m string) bool { return strings.Contains(lower, m) }):
		verdict = pipeline.Injection
	case !threeLetters.MatchString(text):
		verdict = pipeline.Invalid
	}
	probabilities := map[pipeline.Verdict]float64{}
	for _, v := range pipeline.Verdicts {
		probabilities[v] = 0.005
	}
	probabilities[verdict] = 0.99
	return pipeline.GuardVerdict{Verdict: verdict, Confidence: 0.99, Probabilities: probabilities}, usage(), nil
}

// Parser reads each line that is not blank, and not a #fake: directive, as
// one mention: "N x title", "N × title", "title x N", "title × N", or a title
// alone for one copy.
type Parser struct{}

var (
	quantityFirst = regexp.MustCompile(`^(\d+) [x×] (.+)$`)
	quantityLast  = regexp.MustCompile(`^(.+) [x×] (\d+)$`)
)

func (Parser) Parse(_ context.Context, text string) ([]cart.Mention, pipeline.Usage, error) {
	lines := strings.Split(text, "\n")
	if slices.Contains(lines, EngineDown) {
		return nil, usage(), fmt.Errorf("fake parse: %w: %s", pipeline.ErrEngine, EngineDown)
	}
	var mentions []cart.Mention
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, directive) {
			continue
		}
		mentions = append(mentions, mention(line))
	}
	return mentions, usage(), nil
}

func mention(line string) cart.Mention {
	if m := quantityFirst.FindStringSubmatch(line); m != nil {
		if n, ok := quantity(m[1]); ok {
			return cart.Mention{Title: strings.TrimSpace(m[2]), Quantity: n}
		}
	}
	if m := quantityLast.FindStringSubmatch(line); m != nil {
		if n, ok := quantity(m[2]); ok {
			return cart.Mention{Title: strings.TrimSpace(m[1]), Quantity: n}
		}
	}
	return cart.Mention{Title: line, Quantity: 1}
}

// quantity reads N, an integer of at least 1; anything else is part of the
// title. N too large for an int reads as the largest one: still a quantity,
// which the pipeline refuses as too large.
func quantity(s string) (int, bool) {
	n, err := strconv.Atoi(s)
	if errors.Is(err, strconv.ErrRange) {
		return math.MaxInt, true
	}
	return n, err == nil && n >= 1
}

// Identifier knows the saga under its English title only: "back to the
// future" then 1, 2, 3, i, ii or iii, with or without "part", in any case
// and spacing. Every other title is another film.
type Identifier struct{}

var sagaTitle = regexp.MustCompile(`^back to the future (?:part )?(1|2|3|i|ii|iii)$`)

func (Identifier) Identify(_ context.Context, titles []string) ([]pipeline.Identification, pipeline.Usage, error) {
	ids := make([]pipeline.Identification, len(titles))
	for i, t := range titles {
		ids[i] = pipeline.Identification{Film: identify(t), Confidence: 1}
	}
	return ids, usage(), nil
}

func identify(title string) cart.Film {
	m := sagaTitle.FindStringSubmatch(strings.Join(strings.Fields(strings.ToLower(title)), " "))
	if m == nil {
		return cart.Other
	}
	switch m[1] {
	case "1", "i":
		return cart.BTTF1
	case "2", "ii":
		return cart.BTTF2
	}
	return cart.BTTF3
}

// Judge holds every reading faithful, unless the text has an Unfaithful
// line: then the missing check scores 0.
type Judge struct{}

func (Judge) Judge(_ context.Context, text string, lines []cart.Line) (pipeline.Judgement, pipeline.Usage, error) {
	missing := 1.0
	if slices.Contains(strings.Split(text, "\n"), Unfaithful) {
		missing = 0
	}
	var findings []pipeline.Finding
	for _, l := range lines {
		findings = append(findings,
			pipeline.Finding{Check: pipeline.CheckAsked, Label: l.Title, Score: 1},
			pipeline.Finding{Check: pipeline.CheckIdentity, Label: l.Title, Score: 1},
			pipeline.Finding{Check: pipeline.CheckQuantity, Label: fmt.Sprintf("%d × %s", l.Quantity, l.Title), Score: 1},
		)
	}
	findings = append(findings, pipeline.Finding{Check: pipeline.CheckMissing, Label: "the whole reading", Score: missing})
	// every other check scores 1: missing is the worst
	return pipeline.Judgement{Score: missing, Findings: findings}, usage(), nil
}
