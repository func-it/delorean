// Package pipeline reads a free-text cart into priced lines.
//
// It owns the order of the stages and the rules that decide; each model
// stage is a port, answered by a live engine (Jev, an LLM, through
// OpenRouter) or by a deterministic fake in tests:
//
//	prepare → guard → parse   → identify → judge → price
//	                  recount ┘
//
// The recount reads the cart a second time, on another model, beside the
// parse; the judge compares the two readings. A reading the judge refuses is
// read again, told what failed, up to Pipeline.ReadAttempts readings.
// prepare and price are plain code and never call a model.
package pipeline

import (
	"context"
	"errors"

	"github.com/func-it/delorean/quoters/go/internal/cart"
)

// Stage names a step of the reading, as the API contract does.
type Stage string

const (
	StagePrepare  Stage = "prepare"
	StageGuard    Stage = "guard"
	StageParse    Stage = "parse"
	StageRecount  Stage = "recount"
	StageIdentify Stage = "identify"
	StageJudge    Stage = "judge"
	StagePrice    Stage = "price"
)

// Usage is what one stage took. Engines fill Engine, Model, Calls, Ms and
// CostUSD; the pipeline sets Stage.
type Usage struct {
	Stage   Stage
	Engine  string // "jev-1.13", "openai/gpt-6-luna", "fake", "local"
	Model   string
	Calls   int
	Ms      int64
	CostUSD float64
	// Tokens is the input the prepare stage counted.
	Tokens int
	// Degraded: the stage failed and the quote went on without it. Only the
	// recount can: it is a second opinion, and the judge is still the guard.
	Degraded bool
}

// Verdict is the guard's reading of a request.
type Verdict string

const (
	// Valid is a cart: films to buy, in any language or mix of languages,
	// inside a story or not.
	Valid Verdict = "valid"
	// Injection tries to instruct, manipulate or hack the system.
	Injection Verdict = "injection"
	// Invalid is no cart: gibberish, a language not understood, off topic.
	Invalid Verdict = "invalid"
)

// Verdicts are the guard's possible answers.
var Verdicts = []Verdict{Valid, Injection, Invalid}

// GuardVerdict is the guard's answer about one request: the verdict Weigh
// makes of its two questions.
type GuardVerdict struct {
	Verdict       Verdict             `json:"verdict"`
	Confidence    float64             `json:"confidence"`
	Probabilities map[Verdict]float64 `json:"probabilities"`
	Questions     GuardQuestions      `json:"questions"`
}

// GuardQuestions are the guard's two answers, each the probability of yes.
type GuardQuestions struct {
	// Order: the message orders films to buy.
	Order float64 `json:"order"`
	// Steer: some of the message speaks to the system rather than to the
	// shop.
	Steer float64 `json:"steer"`
}

// Weigh makes the guard's verdict of its two answers: injection is steer,
// valid (1 − steer) × order, invalid (1 − steer) × (1 − order). The verdict
// is the likeliest, its confidence its probability; a tie goes to the
// refusal, injection before invalid.
func Weigh(q GuardQuestions) GuardVerdict {
	p := map[Verdict]float64{
		Injection: q.Steer,
		Valid:     (1 - q.Steer) * q.Order,
		Invalid:   (1 - q.Steer) * (1 - q.Order),
	}
	v := GuardVerdict{Verdict: Injection, Confidence: p[Injection], Probabilities: p, Questions: q}
	for _, next := range []Verdict{Invalid, Valid} {
		if p[next] > v.Confidence {
			v.Verdict, v.Confidence = next, p[next]
		}
	}
	return v
}

// Guard decides whether a request is a cart to read at all.
type Guard interface {
	Check(ctx context.Context, text string) (GuardVerdict, Usage, error)
}

// Parser lists the films the customer asks to buy, with their quantities.
// Films mentioned but not bought are left out. The parse and the recount are
// both Parsers. again is nil for a first reading; when the judge refused the
// last one, the parse reads again told what failed, the recount never.
type Parser interface {
	Parse(ctx context.Context, text string, again *Retry) ([]cart.Mention, Usage, error)
}

// Retry is what a reader is told when the judge refused its reading: that
// reading, as the parser read it before any merge, and the checks it failed,
// in the judgement's order.
type Retry struct {
	Reading  []cart.Mention
	Findings []Finding
}

// Identification is what one title was identified as.
type Identification struct {
	Film          cart.Film
	Confidence    float64
	Probabilities map[cart.Film]float64
}

// Identifier identifies titles, one independent judgement per title. It
// answers in the order of titles; the pipeline deduplicates them first
// (Identify).
type Identifier interface {
	Identify(ctx context.Context, titles []string) ([]Identification, Usage, error)
}

// Check is one kind of question the judge puts.
type Check string

const (
	// CheckAsked: the customer asks for this film — nothing was invented.
	CheckAsked Check = "asked"
	// CheckIdentity: the title is the film it was identified as.
	CheckIdentity Check = "identity"
	// CheckMissing: no film the customer asks for is left out of the reading.
	CheckMissing Check = "missing"
	// CheckCount: the reading and the recount give a film as many copies.
	// The pipeline's, in code (Recounted): a Judge does not answer it.
	CheckCount Check = "count"
)

// WholeReading is the label of the missing check: it is put about the whole
// reading.
const WholeReading = "the whole reading"

// Valid reports whether c is one of the judge's checks.
func (c Check) Valid() bool {
	switch c {
	case CheckAsked, CheckIdentity, CheckMissing, CheckCount:
		return true
	}
	return false
}

// Finding is the answer to one question of the judge, as a score where 1
// means faithful.
type Finding struct {
	Check Check   `json:"check"`
	Label string  `json:"label"`
	Score float64 `json:"score"`
}

// Judgement is the judge's view of a reading: every finding, and the worst
// score, which decides. Attempts is the pipeline's: the reading it judges.
// Its JSON is the judge stage's output in a trace.
type Judgement struct {
	Score    float64   `json:"score"`
	Findings []Finding `json:"findings"`
	Attempts int       `json:"attempts"`
}

// Judge holds a reading against the text it was read from. One short
// question per observable fact, asked on its own; the worst answer scores.
// The pipeline adds the count check of each film to its judgement.
type Judge interface {
	Judge(ctx context.Context, text string, lines []cart.Line) (Judgement, Usage, error)
}

// Engines are the ports one pipeline runs on.
type Engines struct {
	// Name is "live" or "fake", as the API reports it.
	Name   string
	Guard  Guard
	Parser Parser
	// Recounter reads the cart a second time, on another model than the
	// Parser's; its reading is compared, never priced.
	Recounter  Parser
	Identifier Identifier
	Judge      Judge
}

// ErrEngine marks a failure of a model engine — unreachable, out of credit,
// or an answer outside its contract. The API answers 502 engine_unavailable.
// Engines wrap their errors with it, keeping the cause reachable:
// fmt.Errorf("jev: %w: %w", ErrEngine, err).
var ErrEngine = errors.New("engine unavailable")
