package decide

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"
)

var film = Question{Key: "film", Kind: Choice, Instructions: "Which film?",
	Criteria: map[string]string{"bttf_1": "the first", "other": "another"}}

// server answers every request with status and body, and keeps what it saw.
func server(t *testing.T, status int, body string, seen *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			if err := json.NewDecoder(r.Body).Decode(seen); err != nil {
				t.Errorf("request body: %v", err)
			}
			(*seen)["authorization"] = r.Header.Get("Authorization")
			(*seen)["x-title"] = r.Header.Get("X-Title")
		}
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// jevAt is Jev pointed at a test server.
func jevAt(url string) *HTTP {
	d := Jev("k", "")
	d.URL = url
	return d
}

// Jev's protocol: its model, its key, the state, the questions by key.
func TestJevSpeaksTheDecisionsProtocol(t *testing.T) {
	answer := `{"id":"d1","answers":{"film":{"choice":"bttf_1","confidence":0.8,"probabilities":{"bttf_1":0.8,"other":0.2}},"yes":{"noul":0.7}},"usage":{"cost":0.00004}}`
	yes := YesNo("yes", "Is it?", "it is", "it is not")
	var seen map[string]any
	d, err := jevAt(server(t, 200, answer, &seen).URL).Decide(context.Background(),
		Request{State: map[string]any{"film_title": "Retour vers le futur"}, Questions: []Question{film, yes}})
	if err != nil {
		t.Fatal(err)
	}
	if d.Answers["film"].Choice != "bttf_1" || d.Answers["yes"].Noul != 0.7 || d.ID != "d1" || d.Cost != 0.00004 {
		t.Errorf("decision %+v", d)
	}
	if d.Engine != "jev-1.13" || d.Model != JevModel {
		t.Errorf("engine %q, model %q", d.Engine, d.Model)
	}
	if seen["authorization"] != "Bearer k" || seen["x-title"] != "delorean" || seen["model"] != JevModel {
		t.Errorf("headers or model: %v", seen)
	}
	if seen["state"].(map[string]any)["film_title"] != "Retour vers le futur" {
		t.Errorf("state sent as %v", seen["state"])
	}
	q := seen["questions"].(map[string]any)["yes"].(map[string]any)
	if q["type"] != "noul" || q["criteria"].(map[string]any)["true"] != "it is" {
		t.Errorf("question sent as %v", q)
	}
}

// The model is configurable, and names the engine.
func TestJevModelIsConfigurable(t *testing.T) {
	d := Jev("k", "typesafe/jev-2.0")
	if d.Model != "typesafe/jev-2.0" || d.Engine() != "jev-2.0" {
		t.Errorf("model %q, engine %q", d.Model, d.Engine())
	}
}

// An engine that drifts is an error, not a verdict: an option the question
// does not have, a question left unanswered, a probability out of range.
func TestAnswersOutsideTheQuestionAreRefused(t *testing.T) {
	for _, body := range []string{
		`{"answers":{"film":{"choice":"bttf_4"}}}`,
		`{"answers":{}}`,
		`{"answers":{"film":{"choice":"other","confidence":1.3}}}`,
	} {
		d := jevAt(server(t, 200, body, nil).URL)
		if _, err := d.Decide(context.Background(), Request{Questions: []Question{film}}); err == nil {
			t.Errorf("%s: accepted", body)
		}
	}
}

// Errors carry the status, which is what Transient reads, and the message.
func TestErrorsCarryStatusAndMessage(t *testing.T) {
	d := jevAt(server(t, 429, `{"error":{"message":"slow down"}}`, nil).URL)
	_, err := d.Decide(context.Background(), Request{Questions: []Question{film}})
	if err == nil || !strings.Contains(err.Error(), "status 429: slow down") || !Transient(err) {
		t.Errorf("rate limited: %v", err)
	}
	d = jevAt(server(t, 402, `{"error":{"message":"insufficient credits"}}`, nil).URL)
	_, err = d.Decide(context.Background(), Request{Questions: []Question{film}})
	if err == nil || !strings.Contains(err.Error(), "insufficient credits") || Transient(err) {
		t.Errorf("out of credit: %v", err)
	}
	d = jevAt(server(t, 502, `<html>bad gateway</html>`, nil).URL)
	_, err = d.Decide(context.Background(), Request{Questions: []Question{film}})
	if err == nil || !strings.Contains(err.Error(), "bad JSON") {
		t.Errorf("not JSON: %v", err)
	}
	if _, err := Jev("", "").Decide(context.Background(), Request{}); !errors.Is(err, ErrNoKey) {
		t.Errorf("no key: %v", err)
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

// The tokens a call took are kept, under either spelling of the usage, and
// go on its span — a generation, with the decision's cost — as Langfuse usage
// details, which the dry run's estimates
// are checked against. No count, no details: a 0 would read as a free call.
func TestJevRecordsItsTokens(t *testing.T) {
	for _, tc := range []struct {
		usage   string
		in, out int
		details string // "" is no attribute
	}{
		{`{"cost":0.00003,"input_tokens":312,"output_tokens":5}`, 312, 5, `{"input":312,"output":5}`},
		{`{"cost":0.00003,"prompt_tokens":298,"completion_tokens":4}`, 298, 4, `{"input":298,"output":4}`},
		{`{"cost":0.00003}`, 0, 0, ""},
	} {
		spans := recordSpans(t)
		body := `{"id":"d1","answers":{"film":{"choice":"other","confidence":0.9}},"usage":` + tc.usage + `}`
		d, err := jevAt(server(t, 200, body, nil).URL).Decide(context.Background(), Request{Questions: []Question{film}})
		if err != nil {
			t.Fatal(err)
		}
		if d.InputTokens != tc.in || d.OutputTokens != tc.out || d.Cost != 0.00003 {
			t.Errorf("%s: decision %+v", tc.usage, d)
		}
		ended := spans.Ended()
		if len(ended) != 1 {
			t.Fatalf("%s: %d spans", tc.usage, len(ended))
		}
		details, cost, kind := "", "", ""
		for _, kv := range ended[0].Attributes() {
			switch kv.Key {
			case "langfuse.observation.usage_details":
				details = kv.Value.AsString()
			case "langfuse.observation.cost_details":
				cost = kv.Value.AsString()
			case "langfuse.observation.type":
				kind = kv.Value.AsString()
			}
		}
		if details != tc.details {
			t.Errorf("%s: usage details %q, want %q", tc.usage, details, tc.details)
		}
		// a generation, its cost the decision's: Langfuse prices no Jev call
		if kind != "generation" || cost != `{"total":3e-05}` {
			t.Errorf("%s: type %q, cost details %q", tc.usage, kind, cost)
		}
	}
}

// Jev keeps its connections alive, as many as a judgement sends at once:
// a second burst of sixteen requests opens none. Go's default transport
// would keep two, and open fourteen again.
func TestJevReusesItsConnections(t *testing.T) {
	var mu sync.Mutex
	opened := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		time.Sleep(20 * time.Millisecond) // the sixteen overlap
		_, _ = w.Write([]byte(`{"id":"d","answers":{"film":{"choice":"other","confidence":0.9}},"usage":{"cost":0.00003}}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			opened++
			mu.Unlock()
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	jev := jevAt(srv.URL)
	reqs := make([]Request, inFlight)
	for i := range reqs {
		reqs[i] = Request{Questions: []Question{film}}
	}
	for range 2 {
		if _, _, err := DecideAll(context.Background(), jev, reqs); err != nil {
			t.Fatal(err)
		}
	}
	if opened > inFlight {
		t.Errorf("%d connections for two bursts of %d", opened, inFlight)
	}
}
