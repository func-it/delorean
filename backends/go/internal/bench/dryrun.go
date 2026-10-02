package bench

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"sync"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/decide"
	"github.com/bn-k/delorean/backends/go/internal/live"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// Estimate is what one pass over a subject's cases would send: the model
// calls, and the tokens of their input. Jev's tokenizer is not published:
// the tokens are counted with the one prepare counts carts with.
type Estimate struct {
	// Variant is what the run would test (Subject.Variant).
	Variant  string
	Jev, LLM int // calls
	Tokens   int
	// Approximate says the count rests on what the cases expect rather than
	// on what the models will answer: the parse decides how many titles are
	// identified and judged.
	Approximate bool
}

// DryRun plays each case once through the subject's own code — its plays and
// its probes — on engines that call nothing, in place of setup's: Jev answers
// each question with its first option, or yes; the parse reads one title per
// film the case expects. It counts what a pass would send.
func DryRun(ctx context.Context, name string, setup Setup, cases []Case, count func(string) int) (Estimate, error) {
	jev := &recorder{count: count}
	llm := &expectedReader{count: count}
	setup.Engines = pipeline.Engines{Name: "dry-run", Guard: live.Guard{Jev: jev}, Parser: llm,
		Identifier: live.Identifier{Jev: jev}, Judge: live.Judge{Jev: jev}}
	s, err := NewSubject(name, setup)
	if err != nil {
		return Estimate{}, err
	}
	for _, c := range cases {
		if err := llm.expect(c); err != nil {
			return Estimate{}, err
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
	return Estimate{Variant: s.Variant, Jev: jev.calls, LLM: llm.calls, Tokens: jev.tokens + llm.tokens,
		Approximate: llm.calls > 0}, nil
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

// expectedReader stands in for the parse in a dry run: it counts the prompt
// the parser would send, and reads one title per film the case expects.
type expectedReader struct {
	count         func(string) int
	films         map[cart.Film]int
	calls, tokens int
}

// expect sets the films of the next case; a case of another subject has none.
func (r *expectedReader) expect(c Case) error {
	var ex readingExpect
	if err := json.Unmarshal(c.Expect, &ex); err != nil {
		return err
	}
	r.films = ex.Films
	return nil
}

func (r *expectedReader) Parse(_ context.Context, text string) ([]cart.Mention, pipeline.Usage, error) {
	r.calls++
	r.tokens += r.count(live.ParsePrompt(text))
	var out []cart.Mention
	for _, f := range cart.Films {
		if n := r.films[f]; n > 0 {
			out = append(out, cart.Mention{Title: string(f), Quantity: n})
		}
	}
	return out, pipeline.Usage{Calls: 1}, nil
}
