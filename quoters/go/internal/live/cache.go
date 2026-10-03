package live

import (
	"container/list"
	"context"
	"fmt"
	"sync"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// cachedIdentifier identifies a title once (docs/architecture.md, 4): its
// film depends on the title alone, and titles come back all day. It keeps
// the last titles' films in memory, keyed by the title's merge key, the
// identify prompt's version and Jev's model, and asks Jev only for the
// others. Only a decision Jev answered is kept, never an error.
type cachedIdentifier struct {
	next  Identifier
	scope string // the identify prompt's version and Jev's model
	cache *lru
}

func newCachedIdentifier(next Identifier, size int, scope string) cachedIdentifier {
	return cachedIdentifier{next: next, scope: scope, cache: newLRU(size)}
}

// attrCacheHits says, on the identify stage's span, how many titles the
// cache answered.
const attrCacheHits = "langfuse.observation.metadata.cache_hits"

func (c cachedIdentifier) Identify(ctx context.Context, titles []string) ([]pipeline.Identification, pipeline.Usage, error) {
	out := make([]pipeline.Identification, len(titles))
	var ask []string
	var at []int
	hits := 0
	for i, t := range titles {
		if id, ok := c.cache.get(c.key(t)); ok {
			out[i] = id
			hits++
			continue
		}
		ask = append(ask, t)
		at = append(at, i)
	}
	// 0 included: every identify says what the cache saved
	trace.SpanFromContext(ctx).SetAttributes(attribute.Int(attrCacheHits, hits))
	if len(ask) == 0 { // every title known: no call at all
		return out, pipeline.Usage{Engine: c.next.Jev.Engine()}, nil
	}
	ids, u, err := c.next.Identify(ctx, ask)
	if err != nil {
		return nil, u, err
	}
	if len(ids) != len(ask) {
		return nil, u, failed(pipeline.StageIdentify, fmt.Errorf("%d identifications for %d titles", len(ids), len(ask)))
	}
	for j, id := range ids {
		out[at[j]] = id
		if id.Film.Valid() && id.Confidence >= 0 && id.Confidence <= 1 { // an answer out of contract is no answer to keep
			c.cache.put(c.key(ask[j]), id)
		}
	}
	return out, u, nil
}

func (c cachedIdentifier) key(title string) string {
	return pipeline.TitleKey(title) + "\x00" + c.scope
}

// lru keeps the last size identifications, the least recently used out
// first. It is safe for concurrent use.
type lru struct {
	mu    sync.Mutex
	size  int
	order *list.List // of *entry, the most recent in front
	at    map[string]*list.Element
}

type entry struct {
	key string
	id  pipeline.Identification
}

func newLRU(size int) *lru {
	return &lru{size: size, order: list.New(), at: map[string]*list.Element{}}
}

func (l *lru) get(key string) (pipeline.Identification, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.at[key]
	if !ok {
		return pipeline.Identification{}, false
	}
	l.order.MoveToFront(e)
	return e.Value.(*entry).id, true
}

func (l *lru) put(key string, id pipeline.Identification) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e, ok := l.at[key]; ok {
		e.Value.(*entry).id = id
		l.order.MoveToFront(e)
		return
	}
	l.at[key] = l.order.PushFront(&entry{key: key, id: id})
	if l.order.Len() > l.size {
		last := l.order.Back()
		l.order.Remove(last)
		delete(l.at, last.Value.(*entry).key)
	}
}
