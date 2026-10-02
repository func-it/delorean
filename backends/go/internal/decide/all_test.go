package decide

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// echo answers each request with the "title" of its state as the decision
// id, the longest titles slowest, and fails on "fail". It counts the requests
// open at once.
type echo struct {
	mu         sync.Mutex
	open, most int
}

func (e *echo) Engine() string { return "echo" }

func (e *echo) Decide(ctx context.Context, r Request) (Decision, error) {
	e.mu.Lock()
	e.open++
	e.most = max(e.most, e.open)
	e.mu.Unlock()
	defer func() { e.mu.Lock(); e.open--; e.mu.Unlock() }()

	title := r.State["title"].(string)
	if title == "fail" {
		return Decision{}, errors.New("echo: status 402: out of credit")
	}
	select {
	case <-ctx.Done():
		return Decision{}, ctx.Err()
	case <-time.After(time.Duration(len(title)) * time.Millisecond):
	}
	return Decision{ID: title}, nil
}

func requests(titles ...string) []Request {
	out := make([]Request, len(titles))
	for i, t := range titles {
		out[i] = Request{State: map[string]any{"title": t}}
	}
	return out
}

// Decisions come back in the order of the requests, whichever answers first,
// and no more than inFlight are open at once.
func TestDecideAllKeepsTheOrderOfRequests(t *testing.T) {
	titles := []string{"ccccccccccccccc", "bbbbbbbbbb", "a"}
	for range 3 * inFlight {
		titles = append(titles, "x")
	}
	e := &echo{}
	ds, err := DecideAll(context.Background(), e, requests(titles...))
	if err != nil {
		t.Fatal(err)
	}
	for i, d := range ds {
		if d.ID != titles[i] {
			t.Fatalf("decision %d is %q, want %q", i, d.ID, titles[i])
		}
	}
	if e.most > inFlight {
		t.Errorf("%d requests open at once, at most %d", e.most, inFlight)
	}
}

// One failed request fails the set: a missing answer is no answer.
func TestDecideAllFailsWithOneFailure(t *testing.T) {
	ds, err := DecideAll(context.Background(), &echo{}, requests("a", "fail", "b"))
	if err == nil || ds != nil {
		t.Errorf("decisions %v, err %v", ds, err)
	}
}
