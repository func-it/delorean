package live

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// A title identified once is not put to Jev again, whatever its case and
// spacing: a hit makes no call and is listed on the stage's span. An error
// is not kept, nor is a title identified under another prompt or model.
func TestIdentifyCache(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	jev, _ := jevServer(t, func(a asked) (int, string) {
		title, _ := a.State["film_title"].(string)
		mu.Lock()
		calls[title]++
		mu.Unlock()
		if strings.Contains(title, "Ride") {
			return 529, `{"error":{"message":"overloaded"}}`
		}
		return 200, `{"answers":{"film":{"choice":"bttf_2","confidence":0.9}},"usage":{"cost":0.00003}}`
	})
	c := newCachedIdentifier(Identifier{Jev: jev}, 2, "v1\x00jev")
	spans := recordSpans(t)

	ids, u, err := c.Identify(context.Background(), []string{"BTTF 2", "Retour vers le futur 2"})
	if err != nil || len(ids) != 2 || u.Calls != 2 {
		t.Fatalf("first: %+v, %+v, %v", ids, u, err)
	}
	ctx, span := startSpan("identify")
	ids, u, err = c.Identify(ctx, []string{"bttf  2", "Retour vers le futur 2"})
	span.End()
	if err != nil || ids[0].Film != cart.BTTF2 || ids[1].Confidence != 0.9 || u.Calls != 0 || u.Engine != "jev-1.13" {
		t.Errorf("all hits: %+v, %+v, %v", ids, u, err)
	}
	if got := attr(spans, "identify", "langfuse.observation.metadata.cache_hits"); got != "2" {
		t.Errorf("cache_hits %q", got)
	}
	ctx, span = startSpan("identify-miss")
	_, _, _ = c.Identify(ctx, []string{"Heat"})
	span.End()
	if got := attr(spans, "identify-miss", "langfuse.observation.metadata.cache_hits"); got != "0" {
		t.Errorf("cache_hits %q on a miss, want 0", got)
	}
	if calls["BTTF 2"] != 1 || calls["bttf  2"] != 0 {
		t.Errorf("calls %v: a hit makes no call", calls)
	}

	for range 2 {
		if _, _, err := c.Identify(context.Background(), []string{"Back to the Future: The Ride"}); err == nil {
			t.Fatal("an error identified")
		}
	}
	if calls["Back to the Future: The Ride"] != 2 {
		t.Errorf("an error was kept: calls %v", calls)
	}

	other := newCachedIdentifier(Identifier{Jev: jev}, 2, "v2\x00jev")
	other.cache = c.cache // the same store, another prompt version
	if _, u, _ := other.Identify(context.Background(), []string{"BTTF 2"}); u.Calls != 1 {
		t.Errorf("another version hit the cache: %+v", u)
	}
}

// The cache keeps the last titles used, and forgets the oldest first.
func TestLRUForgetsTheLeastRecent(t *testing.T) {
	l := newLRU(2)
	id := func(f cart.Film) pipeline.Identification { return pipeline.Identification{Film: f, Confidence: 1} }
	l.put("a", id(cart.BTTF1))
	l.put("b", id(cart.BTTF2))
	l.get("a") // a is used: b is now the oldest
	l.put("c", id(cart.BTTF3))
	for k, want := range map[string]bool{"a": true, "b": false, "c": true} {
		if _, ok := l.get(k); ok != want {
			t.Errorf("%s kept %v, want %v", k, ok, want)
		}
	}
	l.put("a", id(cart.Other))
	if got, _ := l.get("a"); got.Film != cart.Other || l.order.Len() != 2 {
		t.Errorf("a = %+v, %d entries", got, l.order.Len())
	}
}

// New sets the cache when the configuration asks for one, and not at 0.
func TestNewIdentifiesThroughTheCache(t *testing.T) {
	for size, cached := range map[int]bool{0: false, 10: true} {
		e, err := New(Config{OpenRouterKey: "k", IdentifyCacheSize: size})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := e.Identifier.(cachedIdentifier); ok != cached {
			t.Errorf("size %d: identifier %T", size, e.Identifier)
		}
	}
}
