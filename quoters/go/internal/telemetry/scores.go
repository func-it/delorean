package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Scores sends the measures of each quote to Langfuse as scores on its
// trace: cost_usd, latency_ms, attempts and outcome (docs/architecture.md,
// "Usage, cost and traces"). Langfuse 4 aggregates observations, not
// traces: a score is what a dashboard averages per quote. They go off the
// request's path, one ingestion batch a quote, through a queue that Close
// drains; a full queue drops a quote's scores rather than slow a customer.
type Scores struct {
	lf     Langfuse
	client *http.Client
	log    *slog.Logger
	queue  chan pipeline.Measures
	wg     sync.WaitGroup
}

// NewScores starts sending to lf; log says what fails.
func NewScores(lf Langfuse, log *slog.Logger) *Scores {
	s := &Scores{lf: lf, client: &http.Client{Timeout: 10 * time.Second}, log: log, queue: make(chan pipeline.Measures, 256)}
	s.wg.Go(func() {
		for m := range s.queue {
			if err := s.send(context.Background(), m); err != nil {
				s.log.Warn("langfuse scores not sent", "trace_id", m.TraceID, "err", err)
			}
		}
	})
	return s
}

// Quote queues the scores of one quote; it never blocks.
func (s *Scores) Quote(m pipeline.Measures) {
	select {
	case s.queue <- m:
	default:
		s.log.Warn("langfuse scores dropped, the queue is full", "trace_id", m.TraceID)
	}
}

// Close sends what is queued, until ctx ends. Quote must not be called
// after.
func (s *Scores) Close(ctx context.Context) error {
	close(s.queue)
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// score is one score-create event of Langfuse's ingestion API. Its id is the
// trace's and the score's name: sent twice, it is the same score.
type score struct {
	ID       string `json:"id"`
	TraceID  string `json:"traceId"`
	Name     string `json:"name"`
	Value    any    `json:"value"`
	DataType string `json:"dataType"`
}

// scoresOf are the scores of m: attempts only when the cart was read.
func scoresOf(m pipeline.Measures) []score {
	num := func(name string, v float64) score {
		return score{ID: m.TraceID + "-" + name, TraceID: m.TraceID, Name: name, Value: v, DataType: "NUMERIC"}
	}
	out := []score{num("cost_usd", m.CostUSD), num("latency_ms", float64(m.Ms))}
	if m.Attempts > 0 {
		out = append(out, num("attempts", float64(m.Attempts)))
	}
	return append(out, score{ID: m.TraceID + "-outcome", TraceID: m.TraceID, Name: "outcome", Value: m.Outcome, DataType: "CATEGORICAL"})
}

func (s *Scores) send(ctx context.Context, m pipeline.Measures) error {
	type event struct {
		ID        string `json:"id"`
		Type      string `json:"type"`
		Timestamp string `json:"timestamp"`
		Body      score  `json:"body"`
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") // UTC, milliseconds, as every quoter
	var batch []event
	for _, sc := range scoresOf(m) {
		batch = append(batch, event{ID: sc.ID, Type: "score-create", Timestamp: now, Body: sc})
	}
	body, err := json.Marshal(map[string]any{"batch": batch})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.lf.BaseURL+"/api/public/ingestion", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.SetBasicAuth(s.lf.PublicKey, s.lf.SecretKey)
	req.Header.Set("Content-Type", "application/json")
	rsp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer rsp.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(rsp.Body, 4096))
	// 207: one status per event, and an event refused is in "errors"
	var r struct {
		Errors []json.RawMessage `json:"errors"`
	}
	if rsp.StatusCode >= 300 && rsp.StatusCode != http.StatusMultiStatus ||
		json.Unmarshal(answer, &r) == nil && len(r.Errors) > 0 {
		return fmt.Errorf("ingestion: status %d: %s", rsp.StatusCode, answer)
	}
	return nil
}
