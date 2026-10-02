package decide

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"testing"
	"time"
)

// A call that outlasts the client's timeout is the network, not an answer:
// it is retried. A refusal is not.
func TestTransient(t *testing.T) {
	err := fmt.Errorf("jev-1.13: %w", &url.Error{Op: "Post", URL: "https://openrouter.ai", Err: timeoutErr{}})
	if !Transient(err) {
		t.Error("a client timeout is not retried")
	}
	if !Transient(errors.New("jev-1.13: status 429: rate limited")) {
		t.Error("a 429 is not retried")
	}
	if Transient(errors.New("jev-1.13: status 400: bad request")) {
		t.Error("a 400 is retried")
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "Client.Timeout exceeded while awaiting headers" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

// flaky fails with each error of errs in turn, then answers.
type flaky struct {
	errs  []error
	calls int
}

func (f *flaky) Engine() string { return "flaky" }

func (f *flaky) Decide(context.Context, Request) (Decision, error) {
	f.calls++
	if f.calls <= len(f.errs) {
		return Decision{}, f.errs[f.calls-1]
	}
	return Decision{ID: "ok"}, nil
}

// A rate limit is waited out; a refusal is final; attempts are bounded.
func TestRetryingWaitsOutTransientErrorsOnly(t *testing.T) {
	limited := errors.New("jev-1.13: status 429: rate limited")
	for _, tc := range []struct {
		name  string
		errs  []error
		calls int
		ok    bool
	}{
		{"rate limited twice", []error{limited, limited}, 3, true},
		{"refused", []error{errors.New("jev-1.13: status 401: no auth")}, 1, false},
		{"rate limited past the attempts", []error{limited, limited, limited}, 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &flaky{errs: tc.errs}
			d, err := Retrying{Decider: f, Attempts: 3, Wait: time.Millisecond}.Decide(context.Background(), Request{})
			if f.calls != tc.calls || (err == nil) != tc.ok || (tc.ok && d.ID != "ok") {
				t.Errorf("%d calls, decision %+v, err %v", f.calls, d, err)
			}
		})
	}
	if _, ok := WithRetry(&flaky{}, 1).(*flaky); !ok {
		t.Error("one attempt is wrapped")
	}
}
