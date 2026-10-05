package decide

import (
	"context"
	"sync/atomic"

	"golang.org/x/sync/errgroup"
)

// inFlight bounds the requests DecideAll keeps open at once: a long cart is
// hundreds of independent questions, and OpenRouter caps Jev's rate.
const inFlight = 16

// DecideAll sends the requests side by side and returns their decisions in
// the order of the requests. Independent judgements go in separate requests
// and so are answered apart. The first failure cancels the rest: one missing
// answer fails the whole set.
//
// sent is how many requests went out, answered, failed or cancelled: a
// request counts as it leaves, not as its answer comes, so that a set that
// fails still says what it spent. Not counted: a request not sent because
// the set was already cancelled. After a failure the decisions are those
// that were answered in time, the others zero: their cost is spent, their
// answers are not to be used.
func DecideAll(ctx context.Context, d Decider, reqs []Request) (out []Decision, sent int, err error) {
	out = make([]Decision, len(reqs))
	var n atomic.Int64
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(inFlight)
	for i, r := range reqs {
		g.Go(func() error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			n.Add(1)
			var err error
			out[i], err = d.Decide(ctx, r)
			return err
		})
	}
	err = g.Wait()
	return out, int(n.Load()), err
}
