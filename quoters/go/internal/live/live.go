// Package live builds the pipeline's engines on real models, through
// OpenRouter: Jev for the guard, the identification and the judge; two LLMs
// of different families for the parse (GPT-6 Luna by default) and the
// recount (DeepSeek by default).
//
// Two kinds of model, each for what it does well. Jev answers a typed
// question with calibrated probabilities and never writes prose: it decides —
// does this order films, does it speak to the system, which film is this
// title, does the customer ask for this. It does not count or extract (its
// own documentation: it recognises the shape instead of counting), so an LLM
// reads the titles and quantities out of the free text under a JSON schema,
// a second one reads them again, and the judge holds the reading against the
// text and the recount before anything is priced.
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
//   - every word put to a model is read from the repository's prompts/,
//     shared by the three implementations, and versioned by its file's hash
//     (Version), so a bench says what it tested.
package live

import (
	"cmp"
	"errors"
	"fmt"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
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
	// RecountModel is the OpenRouter id of the recounting LLM, of another
	// family than the parser's: "deepseek/deepseek-v4.1-flash".
	RecountModel string
	// RecountEffort is the reasoning effort asked of the recounting LLM.
	RecountEffort string
	// ParseBaseURL and RecountBaseURL are the OpenAI-compatible APIs the two
	// readers are reached at: OpenRouter, or a local server (Ollama,
	// "http://localhost:11434/v1"). Empty, OpenRouter.
	ParseBaseURL, RecountBaseURL string
	// ParseIdentifies has the parse give each line its film too
	// (prompts/parse-films.json): those titles are not put to identify.
	ParseIdentifies bool
	// IdentifyCacheSize is how many titles' films are kept in memory; 0 keeps
	// none.
	IdentifyCacheSize int
	// JevModel is the OpenRouter id of Jev: "typesafe/jev-1.13".
	JevModel string
	// Attempts is how many calls a model request may take when the failure is
	// transient (a rate limit, an overload). Below 2, none is retried: the
	// request path, where a customer waits. Benches wait out a rate limit.
	Attempts int
}

// Defaults of the parse and the recount, when Config leaves them empty.
const (
	DefaultParseModel    = "openai/gpt-6-luna"
	DefaultParseEffort   = "minimal"
	DefaultRecountModel  = "deepseek/deepseek-v4.1-flash"
	DefaultRecountEffort = "low"
)

// OpenRouter is the API every model is reached through, unless a reader's
// base URL says otherwise.
const OpenRouter = "https://openrouter.ai/api/v1"

// Efforts are the reasoning efforts a reader may be asked for; with "none",
// the request carries no reasoning field at all, for a model that has none.
var Efforts = []string{"none", "minimal", "low", "medium", "high"}

// New returns the live engines. It checks the configuration and calls
// nothing: the first call is the first quote.
func New(cfg Config) (pipeline.Engines, error) {
	if cfg.OpenRouterKey == "" {
		return pipeline.Engines{}, errors.New("live engines: OPENROUTER_API_KEY is required")
	}
	jev := decide.WithRetry(decide.Jev(cfg.OpenRouterKey, cfg.JevModel), cfg.Attempts)
	parse := prompts.parse
	if cfg.ParseIdentifies {
		parse = prompts.parseFilms
	}
	var identifier pipeline.Identifier = Identifier{Jev: jev}
	if cfg.IdentifyCacheSize > 0 {
		identifier = newCachedIdentifier(Identifier{Jev: jev}, cfg.IdentifyCacheSize,
			Version(pipeline.StageIdentify)+"\x00"+cmp.Or(cfg.JevModel, decide.JevModel))
	}
	return pipeline.Engines{
		Name:  "live",
		Guard: Guard{Jev: jev},
		Parser: newParser(pipeline.StageParse, cfg, parse, cmp.Or(cfg.ParseBaseURL, OpenRouter),
			cmp.Or(cfg.ParseModel, DefaultParseModel), cmp.Or(cfg.ParseEffort, DefaultParseEffort)),
		Recounter: newParser(pipeline.StageRecount, cfg, prompts.parse, cmp.Or(cfg.RecountBaseURL, OpenRouter),
			cmp.Or(cfg.RecountModel, DefaultRecountModel), cmp.Or(cfg.RecountEffort, DefaultRecountEffort)),
		Identifier: identifier,
		Judge:      Judge{Jev: jev},
	}, nil
}

// The attributes Langfuse reads off a generation's span.
const (
	attrObservationType   = "langfuse.observation.type"
	attrModel             = "langfuse.observation.model.name"
	attrModelParameters   = "langfuse.observation.model.parameters"
	attrObservationInput  = "langfuse.observation.input"
	attrObservationOutput = "langfuse.observation.output"
	attrUsageDetails      = "langfuse.observation.usage_details"
	attrCostDetails       = "langfuse.observation.cost_details"
	attrObservationLevel  = "langfuse.observation.level"
	attrStatusMessage     = "langfuse.observation.status_message"
)

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
