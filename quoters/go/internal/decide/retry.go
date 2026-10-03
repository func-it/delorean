package decide

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"
)

// Transient is an error worth waiting out: OpenRouter caps Jev's rate (429),
// Jev answers 529 when overloaded and 5xx on a reset, the Cloudflare in front
// 520-524, and under load a call can outlast the client's timeout — the
// network, not an answer.
func Transient(err error) bool {
	if err == nil {
		return false
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	e := err.Error()
	for _, code := range []string{"status 429", "status 500", "status 502", "status 503", "status 504",
		"status 520", "status 522", "status 524", "status 529"} {
		if strings.Contains(e, code) {
			return true
		}
	}
	return false
}

// Retrying waits out transient errors: up to Attempts calls, Wait apart, the
// wait doubled each time. For benches only — a customer waiting on a quote
// would rather have an error at once.
type Retrying struct {
	Decider
	Attempts int
	Wait     time.Duration
}

// WithRetry wraps d, 5 s, 10 s, 20 s… apart; attempts below 2 means no retry.
func WithRetry(d Decider, attempts int) Decider {
	if attempts < 2 {
		return d
	}
	return Retrying{Decider: d, Attempts: attempts, Wait: 5 * time.Second}
}

func (r Retrying) Decide(ctx context.Context, req Request) (Decision, error) {
	var d Decision
	var err error
	for attempt := range r.Attempts {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return d, ctx.Err()
			case <-time.After(r.Wait << (attempt - 1)):
			}
		}
		d, err = r.Decider.Decide(ctx, req)
		if !Transient(err) {
			break
		}
	}
	return d, err
}
