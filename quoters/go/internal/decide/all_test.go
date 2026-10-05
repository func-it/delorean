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
	ds, _, err := DecideAll(context.Background(), e, requests(titles...))
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
	_, _, err := DecideAll(context.Background(), &echo{}, requests("a", "fail", "b"))
	if err == nil {
		t.Error("err = nil, want the failure")
	}
}

// gate lets every request of a set start before any answers: so that what
// is counted does not depend on which goroutine the scheduler runs first.
type gate struct {
	started sync.WaitGroup
}

func (g *gate) Engine() string { return "gate" }

func (g *gate) Decide(ctx context.Context, r Request) (Decision, error) {
	g.started.Done()
	g.started.Wait()
	if r.State["title"].(string) == "fail" {
		return Decision{}, errors.New("gate: status 502")
	}
	return Decision{ID: r.State["title"].(string), Cost: 0.25, Model: "gate-model"}, nil
}

// A set that fails still says what it spent: the requests that went out
// count, and the answers that came in time bring their cost.
func TestDecideAllCountsTheRequestsSent(t *testing.T) {
	g := &gate{}
	g.started.Add(3)
	ds, sent, err := DecideAll(context.Background(), g, requests("a", "fail", "b"))
	if err == nil {
		t.Fatal("err = nil, want the failure")
	}
	if sent != 3 {
		t.Errorf("sent = %d, want the 3 requests that went out", sent)
	}
	var cost float64
	for _, d := range ds {
		cost += d.Cost
	}
	if cost != 0.5 {
		t.Errorf("cost of the answers = %v, want 0.5", cost)
	}
}

// A request is not sent once the set is cancelled.
func TestDecideAllDoesNotCountWhatWasNotSent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, sent, err := DecideAll(ctx, &echo{}, requests("a", "b"))
	if err == nil || sent != 0 {
		t.Errorf("sent = %d, err = %v, want no request sent", sent, err)
	}
}
