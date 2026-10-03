package bench

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"sync"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/live"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Estimate is what one pass over a subject's cases would send: the model
// calls, and the tokens of their input. Jev's tokenizer is not published:
// the tokens are counted with the one prepare counts carts with.
type Estimate struct {
	// Variant is what the run would test (Subject.Variant).
	Variant  string
	Jev, LLM int // calls
	// Tokens are the input of all calls; JevTokens and LLMTokens split it,
	// and OutputTokens is what the readings would answer: the expected
	// reading in JSON, reasoning tokens not counted.
	Tokens, JevTokens, LLMTokens, OutputTokens int
	// Approximate says the count rests on the cases rather than on what the
	// models will answer: the parse and the recount decide how many titles
	// are identified and judged, and a reading the judge refuses is read
	// again, up to ReadAttempts times.
	Approximate bool
	// ReadAttempts is how many readings a refused cart may take, for the
	// subject that reads again (reading); the count is for one.
	ReadAttempts int
}

// DryRun plays each case once through the subject's own code — its plays and
// its probes — on engines that call nothing, in place of setup's: Jev answers
// each question with its first option, or yes; the parse and the recount read
// one title per film the case expects, or the case's own lines. It counts what
// a pass would send, each cart read once: the judge's yes to missing would
// otherwise refuse every reading, and read it again.
func DryRun(ctx context.Context, name string, setup Setup, cases []Case, count func(string) int) (Estimate, error) {
	tested, err := NewSubject(name, setup) // what a run would test, its variant
	if err != nil {
		return Estimate{}, err
	}
	setup.ReadAttempts = 1
	jev := &recorder{count: count}
	parse := &expectedReader{count: count, films: setup.ParseIdentifies}
	recount := &expectedReader{count: count}
	setup.Engines = pipeline.Engines{Name: "dry-run", Guard: live.Guard{Jev: jev}, Parser: parse, Recounter: recount,
		Identifier: live.Identifier{Jev: jev}, Judge: live.Judge{Jev: jev}}
	s, err := NewSubject(name, setup)
	if err != nil {
		return Estimate{}, err
	}
	for _, c := range cases {
		for _, r := range []*expectedReader{parse, recount} {
			if err := r.expect(c); err != nil {
				return Estimate{}, err
			}
		}
		answer, _, err := s.Play(ctx, c.Input)
		if err != nil {
			return Estimate{}, err
		}
		b, err := json.Marshal(answer)
		if err != nil {
			return Estimate{}, err
		}
		for _, m := range s.Metrics {
			if m.Probe == nil {
				continue
			}
			if _, _, err := m.Probe(ctx, string(b), c); err != nil {
				return Estimate{}, err
			}
		}
	}
	llm := parse.calls + recount.calls
	est := Estimate{Variant: tested.Variant, Jev: jev.calls, LLM: llm, JevTokens: jev.tokens,
		LLMTokens: parse.tokens + recount.tokens, OutputTokens: parse.output + recount.output, Approximate: llm > 0}
	est.Tokens = est.JevTokens + est.LLMTokens
	if name == "reading" {
		est.ReadAttempts = max(tested.readAttempts, 1)
	}
	return est, nil
}

// recorder stands in for Jev in a dry run: it counts each request and the
// tokens of its state and questions, and answers every question with its
// first option, or yes.
type recorder struct {
	count         func(string) int
	mu            sync.Mutex
	calls, tokens int
}

func (r *recorder) Engine() string { return "dry-run" }

func (r *recorder) Decide(_ context.Context, req decide.Request) (decide.Decision, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return decide.Decision{}, err
	}
	d := decide.Decision{Answers: map[string]decide.Answer{}, Engine: r.Engine()}
	for _, q := range req.Questions {
		a := decide.Answer{Noul: 1, Confidence: 1}
		if q.Kind == decide.Choice {
			a.Choice = slices.Sorted(maps.Keys(q.Criteria))[0]
		}
		d.Answers[q.Key] = a
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.tokens += r.count(string(body))
	return d, nil
}

// expectedReader stands in for the parse or the recount in a dry run: it
// counts the prompt a reading would send and the reading it would answer,
// and reads one title per film the case expects (reading), or the lines the
// case gives (judge). films reads as parse-films.json does: each line with
// its film.
type expectedReader struct {
	count                 func(string) int
	films                 bool
	mentions              []cart.Mention
	mu                    sync.Mutex
	calls, tokens, output int
}

// expect sets what the next case reads; a case of another subject has none.
func (r *expectedReader) expect(c Case) error {
	var ex readingExpect
	if err := json.Unmarshal(c.Expect, &ex); err != nil {
		return err
	}
	var in judgeInput
	if err := json.Unmarshal(c.Input, &in); err != nil {
		return err
	}
	r.mentions = nil
	for _, f := range cart.Films {
		if n := ex.Films[f]; n > 0 {
			r.mentions = append(r.mentions, cart.Mention{Title: string(f), Quantity: n, Film: f})
		}
	}
	for _, l := range in.Lines {
		r.mentions = append(r.mentions, cart.Mention{Title: l.Title, Quantity: l.Quantity, Film: l.Film})
	}
	if !r.films {
		for i := range r.mentions {
			r.mentions[i].Film = ""
		}
	}
	return nil
}

func (r *expectedReader) Parse(_ context.Context, text string, _ *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.tokens += r.count(live.ParsePrompt(text, r.films))
	answer, _ := json.Marshal(map[string]any{"films": r.mentions}) // plain data: it always marshals
	r.output += r.count(string(answer))
	return slices.Clone(r.mentions), pipeline.Usage{Calls: 1}, nil
}
