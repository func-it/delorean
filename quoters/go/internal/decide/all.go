package decide

import (
	"context"

	"golang.org/x/sync/errgroup"
)

// inFlight bounds the requests DecideAll keeps open at once: a long cart is
// hundreds of independent questions, and OpenRouter caps Jev's rate.
const inFlight = 16

// DecideAll sends the requests side by side and returns their decisions in
// the order of the requests. Independent judgements go in separate requests
// and so are answered apart. The first failure cancels the rest: one missing
// answer fails the whole set.
func DecideAll(ctx context.Context, d Decider, reqs []Request) ([]Decision, error) {
	out := make([]Decision, len(reqs))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(inFlight)
	for i, r := range reqs {
		g.Go(func() error {
			var err error
			out[i], err = d.Decide(ctx, r)
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}
