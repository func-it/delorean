package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/bn-k/delorean/backends/go/internal/decide"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// asked is one request as the decisions endpoint received it.
type asked struct {
	Model     string                    `json:"model"`
	State     map[string]any            `json:"state"`
	Questions map[string]map[string]any `json:"questions"`
}

// question is the only question of the request, and its key.
func (a asked) question(t *testing.T) (string, map[string]any) {
	t.Helper()
	if len(a.Questions) != 1 {
		t.Fatalf("%d questions in one request, want 1: %v", len(a.Questions), a.Questions)
	}
	for k, q := range a.Questions {
		return k, q
	}
	return "", nil
}

// jevServer stands in for OpenRouter's decisions endpoint: answer turns each
// request into a status and a body. It returns Jev pointed at it, and every
// request it saw.
func jevServer(t *testing.T, answer func(a asked) (int, string)) (*decide.HTTP, func() []asked) {
	t.Helper()
	var mu sync.Mutex
	var seen []asked
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var a asked
		if err := json.NewDecoder(r.Body).Decode(&a); err != nil {
			t.Errorf("request body: %v", err)
		}
		mu.Lock()
		seen = append(seen, a)
		mu.Unlock()
		status, body := answer(a)
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	jev := decide.Jev("k", "")
	jev.URL = srv.URL
	return jev, func() []asked { mu.Lock(); defer mu.Unlock(); return append([]asked(nil), seen...) }
}

// New checks its configuration and calls nothing.
func TestNewRequiresAKeyAndCallsNothing(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Error("no key accepted")
	}
	e, err := New(Config{OpenRouterKey: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if e.Name != "live" || e.Guard == nil || e.Parser == nil || e.Identifier == nil || e.Judge == nil {
		t.Errorf("engines %+v", e)
	}
}

// Each model stage has a version of its own, stable from one call to the
// next; the stages without a model have none.
func TestVersionNamesWhatEachStageAsks(t *testing.T) {
	seen := map[string]pipeline.Stage{}
	for _, s := range []pipeline.Stage{pipeline.StageGuard, pipeline.StageParse, pipeline.StageIdentify, pipeline.StageJudge} {
		v := Version(s)
		if len(v) != 8 || v != Version(s) {
			t.Errorf("%s: version %q", s, v)
		}
		if other, dup := seen[v]; dup {
			t.Errorf("%s and %s share version %s", s, other, v)
		}
		seen[v] = s
	}
	if v := Version(pipeline.StagePrice); v != "" {
		t.Errorf("price has version %q", v)
	}
}

// Every engine failure reads as pipeline.ErrEngine, whatever the engine.
func isEngineErr(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, pipeline.ErrEngine) {
		t.Errorf("error %v is not pipeline.ErrEngine", err)
	}
}

// An engine failure is ErrEngine for the pipeline, and keeps its cause for
// whoever reads the log.
func TestEngineFailuresKeepTheirCause(t *testing.T) {
	_, _, err := Guard{Jev: decide.Jev("", "")}.Check(context.Background(), "BTTF 2")
	isEngineErr(t, err)
	if !errors.Is(err, decide.ErrNoKey) {
		t.Errorf("error %v lost its cause", err)
	}
}
