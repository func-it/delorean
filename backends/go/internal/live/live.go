// Package live builds the pipeline's engines on real models, through
// OpenRouter: Jev for the guard, the identification and the judge; an LLM
// (GPT-6 Luna by default) for the parse.
//
// Two kinds of model, each for what it does well. Jev answers a typed
// question with calibrated probabilities and never writes prose: it decides —
// is this a cart, which film is this title, does the customer ask for this.
// It does not count or extract (its own documentation: it recognises the
// shape instead of counting), so the LLM reads the titles and quantities out
// of the free text under a JSON schema, and Jev's judge then holds that
// reading against the text before anything is priced.
//
// What every engine keeps to:
//   - the customer's text is data, never instructions: it goes into Jev's
//     state under a key named for what it is, into the LLM's user turn
//     between tags, and every prompt says so;
//   - one request per independent judgement, all in parallel: questions put
//     in the same request colour one another;
//   - no retry in the request path, a person is waiting: a failure is
//     pipeline.ErrEngine at once (benches set Config.Attempts);
//   - any failure, and any answer outside the contract, wraps
//     pipeline.ErrEngine;
//   - the questions and the prompt are versioned (Version), so a bench says
//     what it tested.
package live

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/decide"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// Config is what live engines need. It is read from the environment by the
// caller (see internal/config).
type Config struct {
	// OpenRouterKey is the bearer key of OpenRouter. Required.
	OpenRouterKey string
	// ParseModel is the OpenRouter id of the parsing LLM: "openai/gpt-6-luna".
	ParseModel string
	// ParseEffort is the reasoning effort asked of the parsing LLM.
	ParseEffort string
	// JevModel is the OpenRouter id of Jev: "typesafe/jev-1.13".
	JevModel string
	// Attempts is how many calls a model request may take when the failure is
	// transient (a rate limit, an overload). Below 2, none is retried: the
	// request path, where a customer waits. Benches wait out a rate limit.
	Attempts int
}

// Defaults of the parse, when Config leaves them empty.
const (
	DefaultParseModel  = "openai/gpt-6-luna"
	DefaultParseEffort = "low"
)

const openRouter = "https://openrouter.ai/api/v1"

// New returns the live engines. It checks the configuration and calls
// nothing: the first call is the first quote.
func New(cfg Config) (pipeline.Engines, error) {
	if cfg.OpenRouterKey == "" {
		return pipeline.Engines{}, errors.New("live engines: OPENROUTER_API_KEY is required")
	}
	jev := decide.WithRetry(decide.Jev(cfg.OpenRouterKey, cfg.JevModel), cfg.Attempts)
	return pipeline.Engines{
		Name:       "live",
		Guard:      Guard{Jev: jev},
		Parser:     newParser(cfg, openRouter),
		Identifier: Identifier{Jev: jev},
		Judge:      Judge{Jev: jev},
	}, nil
}

// Version names what the engine of a stage asks — its questions, or its
// prompt and schema — by a short hash: two bench runs with the same version
// tested the same thing. Stages without a model have none.
func Version(s pipeline.Stage) string {
	switch s {
	case pipeline.StageGuard:
		return version(verdictQuestion)
	case pipeline.StageParse:
		return version(parseInstruction, parseSchema)
	case pipeline.StageIdentify:
		return version(filmQuestion)
	case pipeline.StageJudge:
		return version(askedQuestion, identityQuestion, quantityQuestion, missingQuestion)
	}
	return ""
}

func version(parts ...any) string {
	b, _ := json.Marshal(parts) // questions and schemas are plain data: they always marshal
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:4])
}

// failed wraps an engine's failure for the pipeline, which answers 502; the
// cause stays reachable, a deadline or a refused key.
func failed(s pipeline.Stage, err error) error {
	return fmt.Errorf("%s: %w: %w", s, pipeline.ErrEngine, err)
}

// jevUsage is what a set of Jev decisions took, since start.
func jevUsage(jev decide.Decider, start time.Time, ds ...decide.Decision) pipeline.Usage {
	u := pipeline.Usage{Engine: jev.Engine(), Calls: len(ds), Ms: time.Since(start).Milliseconds()}
	for _, d := range ds {
		u.Model = d.Model
		u.CostUSD += d.Cost
	}
	return u
}
