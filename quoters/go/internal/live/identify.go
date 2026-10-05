package live

import (
	"context"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Identifier asks Jev which film each title is: one request per title, all
// in parallel. A title read next to others would be coloured by them, and a
// long, noisy state distracts Jev.
type Identifier struct{ Jev decide.Decider }

func (id Identifier) Identify(ctx context.Context, titles []string) ([]pipeline.Identification, pipeline.Usage, error) {
	start := time.Now()
	film := prompts.identify.Film
	reqs := make([]decide.Request, len(titles))
	for i, t := range titles {
		reqs[i] = decide.Request{State: map[string]any{"film_title": t}, Questions: []decide.Question{film}}
	}
	ds, sent, err := decide.DecideAll(ctx, id.Jev, reqs)
	if err != nil {
		return nil, jevUsage(id.Jev, start, sent, ds), failed(pipeline.StageIdentify, err)
	}
	out := make([]pipeline.Identification, len(ds))
	for i, d := range ds {
		a := d.Answers[film.Key]
		probs := make(map[cart.Film]float64, len(a.Probabilities))
		for k, p := range a.Probabilities {
			probs[cart.Film(k)] = p
		}
		out[i] = pipeline.Identification{Film: cart.Film(a.Choice), Confidence: a.Confidence, Probabilities: probs}
	}
	return out, jevUsage(id.Jev, start, sent, ds), nil
}
