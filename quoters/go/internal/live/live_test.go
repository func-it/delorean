package live

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
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
	if e.Name != "live" || e.Guard == nil || e.Parser == nil || e.Recounter == nil || e.Identifier == nil || e.Judge == nil {
		t.Errorf("engines %+v", e)
	}
	parser, recounter := e.Parser.(*Parser), e.Recounter.(*Parser)
	if parser.model != DefaultParseModel || recounter.model != DefaultRecountModel || recounter.stage != pipeline.StageRecount {
		t.Errorf("parse on %s, recount on %s (%s)", parser.model, recounter.model, recounter.stage)
	}
}

// promptsDir is the repository's prompts/, the files the prompts module
// embeds.
const promptsDir = "../../../../prompts"

// A stage's version is the first 8 hex digits of the SHA-256 of the file it
// reads; the recount reads the parse's, the stages without a model none.
func TestVersionIsTheHashOfTheFile(t *testing.T) {
	for s, name := range map[pipeline.Stage]string{
		pipeline.StageGuard:    "guard.json",
		pipeline.StageParse:    "parse.json",
		pipeline.StageRecount:  "parse.json",
		pipeline.StageIdentify: "identify.json",
		pipeline.StageJudge:    "judge.json",
	} {
		b, err := os.ReadFile(filepath.Join(promptsDir, name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		if want := hex.EncodeToString(sum[:])[:8]; Version(s) != want {
			t.Errorf("%s: version %q, want %q", s, Version(s), want)
		}
	}
	if v := Version(pipeline.StagePrice); v != "" {
		t.Errorf("price has version %q", v)
	}
	// the parse that identifies reads parse-films.json, a file of its own
	b, err := os.ReadFile(filepath.Join(promptsDir, "parse-films.json"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if want := hex.EncodeToString(sum[:])[:8]; ParseVersion(true) != want || ParseVersion(false) != Version(pipeline.StageParse) {
		t.Errorf("parse versions %q, %q; want %q and parse.json's", ParseVersion(true), ParseVersion(false), want)
	}
}

// A file that drifts from what the engines read is refused before anything
// starts.
func TestPromptsAreChecked(t *testing.T) {
	if err := prompts.check(); err != nil {
		t.Fatal(err)
	}
	p := prompts
	p.guard.Steer.Kind = decide.Choice
	p.judge.Films = map[cart.Film]string{cart.BTTF1: "volume 1"}
	p.parse.Message.After = ""
	p.parse.Retry.Turn = "Read it again."
	p.parse.Retry.Meanings = map[pipeline.Check]string{pipeline.CheckAsked: "not asked"}
	err := p.check()
	for _, want := range []string{`"steer" must be a noul question`, "films.bttf_2 has no name", "parse.json: an instruction",
		"retry.turn must hold {findings}", "retry.meanings.count is missing"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("err %v does not say %q", err, want)
		}
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

// recordSpans sets trpc-agent-go's tracer, a global, to one that records:
// the tests that call it do not run in parallel.
func recordSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	spans := tracetest.NewSpanRecorder()
	previous := atrace.Tracer
	atrace.Tracer = sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans)).Tracer("test")
	t.Cleanup(func() { atrace.Tracer = previous })
	return spans
}

// startSpan opens a span as a pipeline stage does.
func startSpan(name string) (context.Context, oteltrace.Span) {
	return atrace.Tracer.Start(context.Background(), name)
}

// attr is the attribute key of the span named name, "" when there is none.
func attr(spans *tracetest.SpanRecorder, name, key string) string {
	for _, s := range spans.Ended() {
		if s.Name() != name {
			continue
		}
		for _, kv := range s.Attributes() {
			if string(kv.Key) == key {
				return kv.Value.String()
			}
		}
	}
	return ""
}
