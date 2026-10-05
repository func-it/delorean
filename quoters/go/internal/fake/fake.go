// Package fake holds the engines of ENGINES=fake: deterministic stand-ins for
// Jev and the LLM, for end-to-end tests without OpenRouter, never in
// production. Their rules are part of the test contract and the same in every
// implementation (docs/architecture.md, "Fake engines").
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

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Lines of a cart that drive the fakes instead of naming films.
const (
	// Unfaithful, a line of its own, fails the judge's missing check, at
	// every attempt.
	Unfaithful = "#fake:unfaithful"
	// Reread, a line of its own, makes the parse leave out its last mention
	// on a first reading, and read everything when told what failed: the
	// cart is priced on the second attempt.
	Reread = "#fake:reread"
	// Miscount, a line of its own, makes the recount read one more copy of
	// the first mention: the count check fails for its film.
	Miscount = "#fake:miscount"
	// EngineDown, a line of its own, fails the parse as an engine fails.
	EngineDown = "#fake:engine_down"
	// RecountOffSchema, a line of its own, makes the recount answer off its
	// schema at every call: the quote goes on without it.
	RecountOffSchema = "#fake:recount_offschema"
	directive        = "#fake:"
)

// New returns the fake engines, instant.
func New() pipeline.Engines { return NewWith(Latency{}) }

// NewWith returns the fake engines, taking the time l says.
func NewWith(l Latency) pipeline.Engines {
	return pipeline.Engines{Name: "fake", Guard: Guard{l}, Parser: Parser{l}, Recounter: Recounter{l},
		Identifier: Identifier{l}, Judge: Judge{l}}
}

// usage is the same for every fake stage: one call, free.
func usage() pipeline.Usage {
	return pipeline.Usage{Engine: "fake", Calls: 1}
}

// Guard answers steer 0.99 for a text with one of injectionMarks in any
// case, 0.01 otherwise; order 1 for a text with a run of three letters, 0
// otherwise. The verdict is pipeline.Weigh's, as for the live guard:
// injection, valid or invalid, at 0.99.
type Guard struct{ Latency Latency }

var (
	injectionMarks = []string{"ignore", "disregard", "oublie", "instruction", "system prompt", "<script", "drop table"}
	threeLetters   = regexp.MustCompile(`\p{L}{3}`)
)

func (g Guard) Check(ctx context.Context, text string) (pipeline.GuardVerdict, pipeline.Usage, error) {
	if err := g.Latency.take(ctx, pipeline.StageGuard, text); err != nil {
		return pipeline.GuardVerdict{}, usage(), err
	}
	lower := strings.ToLower(text)
	q := pipeline.GuardQuestions{Steer: 0.01}
	if slices.ContainsFunc(injectionMarks, func(m string) bool { return strings.Contains(lower, m) }) {
		q.Steer = 0.99
	}
	if threeLetters.MatchString(text) {
		q.Order = 1
	}
	return pipeline.Weigh(q), usage(), nil
}

// Parser reads each line that is not blank, and not a #fake: directive, as
// one mention: "N x title", "N × title", "title x N", "title × N", or a title
// alone for one copy. With a Reread line, a first reading leaves out the last
// mention.
type Parser struct{ Latency Latency }

var (
	quantityFirst = regexp.MustCompile(`^(\d+) [x×] (.+)$`)
	quantityLast  = regexp.MustCompile(`^(.+) [x×] (\d+)$`)
)

func (p Parser) Parse(ctx context.Context, text string, again *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	if err := p.Latency.take(ctx, pipeline.StageParse, text); err != nil {
		return nil, usage(), err
	}
	mentions, err := read(text)
	if err == nil && again == nil && len(mentions) > 0 && hasLine(text, Reread) {
		mentions = mentions[:len(mentions)-1]
	}
	return mentions, usage(), err
}

// Recounter reads as Parser does in full, but for a text with a Miscount
// line: then it reads one more copy of the first mention. With a
// RecountOffSchema line it answers off its schema.
type Recounter struct{ Latency Latency }

func (r Recounter) Parse(ctx context.Context, text string, _ *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	if err := r.Latency.take(ctx, pipeline.StageRecount, text); err != nil {
		return nil, usage(), err
	}
	if hasLine(text, RecountOffSchema) {
		return nil, usage(), fmt.Errorf("fake recount: %w: answer off schema (%s)", pipeline.ErrEngine, RecountOffSchema)
	}
	mentions, err := read(text)
	if err == nil && len(mentions) > 0 && hasLine(text, Miscount) {
		mentions[0].Quantity += min(1, math.MaxInt-mentions[0].Quantity)
	}
	return mentions, usage(), err
}

// read is the fake reading of text: every mention, in order. An EngineDown
// line fails it as an engine fails.
func read(text string) ([]cart.Mention, error) {
	if hasLine(text, EngineDown) {
		return nil, fmt.Errorf("fake %w (%s)", pipeline.ErrEngine, EngineDown)
	}
	var mentions []cart.Mention
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, directive) {
			continue
		}
		mentions = append(mentions, mention(line))
	}
	return mentions, nil
}

// hasLine reports whether a line of text is exactly line.
func hasLine(text, line string) bool { return slices.Contains(strings.Split(text, "\n"), line) }

// key is what two spellings of one title share, as the pipeline merges them.
func key(title string) string { return pipeline.TitleKey(title) }

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
type Identifier struct{ Latency Latency }

var sagaTitle = regexp.MustCompile(`^back to the future (?:part )?(1|2|3|i|ii|iii)$`)

func (id Identifier) Identify(ctx context.Context, titles []string) ([]pipeline.Identification, pipeline.Usage, error) {
	if err := id.Latency.take(ctx, pipeline.StageIdentify, titlesInput(titles)); err != nil {
		return nil, usage(), err
	}
	ids := make([]pipeline.Identification, len(titles))
	for i, t := range titles {
		ids[i] = pipeline.Identification{Film: identify(t), Confidence: 1}
	}
	return ids, usage(), nil
}

func identify(title string) cart.Film {
	m := sagaTitle.FindStringSubmatch(key(title))
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

// Judge holds every reading faithful, but for its missing check, which
// scores 0 when the text has an Unfaithful line or when the reading lacks a
// title the fake reading has. The count check is the pipeline's.
type Judge struct{ Latency Latency }

func (j Judge) Judge(ctx context.Context, text string, lines []cart.Line) (pipeline.Judgement, pipeline.Usage, error) {
	if err := j.Latency.take(ctx, pipeline.StageJudge, text); err != nil {
		return pipeline.Judgement{}, usage(), err
	}
	missing := 1.0
	if hasLine(text, Unfaithful) {
		missing = 0
	}
	named := map[string]bool{}
	for _, l := range lines {
		named[key(l.Title)] = true
	}
	all, _ := read(text) // the reading came from it: it reads
	for _, m := range all {
		if !named[key(m.Title)] {
			missing = 0
		}
	}
	var findings []pipeline.Finding
	for _, l := range lines {
		findings = append(findings,
			pipeline.Finding{Check: pipeline.CheckAsked, Label: l.Title, Score: 1},
			pipeline.Finding{Check: pipeline.CheckIdentity, Label: l.Title, Score: 1},
		)
	}
	findings = append(findings, pipeline.Finding{Check: pipeline.CheckMissing, Label: pipeline.WholeReading, Score: missing})
	// every other check scores 1: missing is the worst
	return pipeline.Judgement{Score: missing, Findings: findings}, usage(), nil
}
