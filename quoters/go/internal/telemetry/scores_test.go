package telemetry

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Each quote's measures go to Langfuse's ingestion API in one batch of
// scores on its trace — attempts only when the cart was read — and Close
// sends what is queued.
func TestScoresSendTheMeasuresOfEachQuote(t *testing.T) {
	var mu sync.Mutex
	var batches [][]map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, _ := r.BasicAuth(); r.URL.Path != "/api/public/ingestion" || user != "pk" || pass != "sk" {
			t.Errorf("%s %s as %s", r.Method, r.URL.Path, user)
		}
		var body struct {
			Batch []struct {
				Type string         `json:"type"`
				Body map[string]any `json:"body"`
			} `json:"batch"`
		}
		b, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(b, &body); err != nil {
			t.Errorf("body %s: %v", b, err)
		}
		var scores []map[string]any
		for _, e := range body.Batch {
			if e.Type != "score-create" {
				t.Errorf("event %s", e.Type)
			}
			scores = append(scores, e.Body)
		}
		mu.Lock()
		batches = append(batches, scores)
		mu.Unlock()
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write([]byte(`{"successes":[],"errors":[]}`))
	}))
	t.Cleanup(srv.Close)

	s := NewScores(Langfuse{PublicKey: "pk", SecretKey: "sk", BaseURL: srv.URL}, slog.New(slog.DiscardHandler))
	s.Quote(pipeline.Measures{TraceID: "t1", CostUSD: 0.00047, Ms: 3810, Attempts: 2, Outcome: "priced"})
	s.Quote(pipeline.Measures{TraceID: "t2", CostUSD: 0.00006, Ms: 410, Outcome: "injection"})
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := [][]map[string]any{
		{
			{"id": "t1-cost_usd", "traceId": "t1", "name": "cost_usd", "value": 0.00047, "dataType": "NUMERIC"},
			{"id": "t1-latency_ms", "traceId": "t1", "name": "latency_ms", "value": 3810.0, "dataType": "NUMERIC"},
			{"id": "t1-attempts", "traceId": "t1", "name": "attempts", "value": 2.0, "dataType": "NUMERIC"},
			{"id": "t1-outcome", "traceId": "t1", "name": "outcome", "value": "priced", "dataType": "CATEGORICAL"},
		},
		{
			{"id": "t2-cost_usd", "traceId": "t2", "name": "cost_usd", "value": 0.00006, "dataType": "NUMERIC"},
			{"id": "t2-latency_ms", "traceId": "t2", "name": "latency_ms", "value": 410.0, "dataType": "NUMERIC"},
			{"id": "t2-outcome", "traceId": "t2", "name": "outcome", "value": "injection", "dataType": "CATEGORICAL"},
		},
	}
	if got, _ := json.Marshal(batches); string(got) != mustJSON(t, want) {
		t.Errorf("batches %s\nwant %s", got, mustJSON(t, want))
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
