package live

import (
	"context"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Guard asks Jev about a request before any LLM reads it: does it order
// films (order), does some of it speak to the system rather than to the shop
// (steer)? Two facts, each in a request of its own, side by side: a single
// question for one of three verdicts weighed both at once. pipeline.Weigh
// makes the verdict of the two answers.
type Guard struct{ Jev decide.Decider }

// customerMessage is the state key of the customer's text, wherever Jev
// reads it.
const customerMessage = "customer_message"

func (g Guard) Check(ctx context.Context, text string) (pipeline.GuardVerdict, pipeline.Usage, error) {
	start := time.Now()
	order, steer := prompts.guard.Order, prompts.guard.Steer
	ds, err := decide.DecideAll(ctx, g.Jev, []decide.Request{
		{State: map[string]any{customerMessage: text}, Questions: []decide.Question{order}},
		{State: map[string]any{customerMessage: text}, Questions: []decide.Question{steer}},
	})
	if err != nil {
		return pipeline.GuardVerdict{}, jevUsage(g.Jev, start), failed(pipeline.StageGuard, err)
	}
	return pipeline.Weigh(pipeline.GuardQuestions{Order: ds[0].Answers[order.Key].Noul, Steer: ds[1].Answers[steer.Key].Noul}),
		jevUsage(g.Jev, start, ds...), nil
}
