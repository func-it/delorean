package bench

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// The parse subject reads as the pipeline's first reading: the parse, its
// mentions merged, identify — whose calls a parse that identifies saves —
// and counts each stage's latency and cost apart.
func TestParseReadsTheFirstReadingAlone(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	p := parsed{{Title: "BTTF 2", Quantity: 1}, {Title: "bttf 2", Quantity: 1}, {Title: "La chèvre", Quantity: 1}}
	s := subject(t, "parse", jevEngines(identifies(&asked, &mu), p, nil))
	answer, usage, err := s.Play(context.Background(), json.RawMessage(`{"text":"…"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := answer.(readingAnswer)
	if got.Films[cart.BTTF2] != 2 || got.Films[cart.Other] != 1 || len(asked) != 2 {
		t.Errorf("films %v, identified %q", got.Films, asked)
	}
	if len(usage) != 2 || usage[0].Stage != pipeline.StageParse || usage[1].Stage != pipeline.StageIdentify || usage[1].Calls != 2 {
		t.Errorf("usage %+v", usage)
	}
	s.Stats.played(0, usage, nil)
	sum := s.Stats.Summary()
	if sum.Stages[pipeline.StageParse].Cost != 0.0002 || sum.Stages[pipeline.StageIdentify].Cost < 0.0002-1e-12 {
		t.Errorf("summary %+v", sum)
	}

	// read with its films, the parse leaves identify nothing to ask
	asked = nil
	withFilms := parsed{{Title: "BTTF 2", Quantity: 1, Film: cart.BTTF2}}
	answer, usage, err = subject(t, "parse", jevEngines(identifies(&asked, &mu), withFilms, nil)).Play(context.Background(), json.RawMessage(`{"text":"…"}`))
	if err != nil || answer.(readingAnswer).Films[cart.BTTF2] != 1 || len(asked) != 0 || usage[1].Calls != 0 {
		t.Errorf("films read: %+v, %+v, %v, identified %q", answer, usage, err, asked)
	}
	if Folder("parse") != "reading" || Folder("judge") != "judge" {
		t.Error("folders")
	}
}

// A variants file names each variant once, in a name a file and an
// experiment can take.
func TestLoadVariants(t *testing.T) {
	write := func(body string) string {
		path := filepath.Join(t.TempDir(), "variants.yaml")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	v, err := LoadVariants(write("variants:\n  - name: luna-low\n    env: {PARSE_EFFORT: low}\n  - name: local-llama3.2-3b\n    note: n\n    env: {}\n"))
	if err != nil || len(v) != 2 || v[0].Env["PARSE_EFFORT"] != "low" || v[1].Note != "n" {
		t.Fatalf("%+v, %v", v, err)
	}
	for body, want := range map[string]string{
		"variants: []\n":                            "no variant",
		"variants:\n  - name: a\n  - name: a\n":     `variant "a" twice`,
		"variants:\n  - name: Luna Low\n":           "lowercase letters",
		"variants:\n  - name: a\n    model: luna\n": "field model not found",
	} {
		if _, err := LoadVariants(write(body)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: err %v, want %q", body, err, want)
		}
	}
}

// A run's row: the runs passed of the first metric, the cases with a run
// failed, the parse's latency, the mean cost of a cart, the errors.
func TestRowOf(t *testing.T) {
	rep := &Report{
		Cases: []string{"a", "b"}, Metrics: []string{"films"}, Thresholds: map[string]float64{"films": 1},
		Scores: map[string][]Scored{
			"a": {{Passed: true, Scores: map[string]float64{"films": 1}}, {Passed: true, Scores: map[string]float64{"films": 1}}},
			"b": {{Passed: false, Scores: map[string]float64{"films": 0}}, {}}, // the second play failed: unscored
		},
	}
	sum := Summary{Plays: 3, Failed: 1, Cost: 0.0008, Stages: map[pipeline.Stage]StageSummary{pipeline.StageParse: {P50: 900, P90: 1400}}}
	row := RowOf(Row{Variant: "luna-low"}, rep, sum)
	if row.Passed != 2 || row.Scored != 3 || row.CasesFailed != 1 || row.P50 != 900 || row.P90 != 1400 || row.CostPerCart != 0.0002 || row.Errors != 1 {
		t.Errorf("row %+v", row)
	}
	table := Table([]Row{row})
	if !strings.Contains(table, "| luna-low |  |  |  | 2 / 3 (67 %) | 1 | 900 ms | 1400 ms | $0.000200 | $0.200 | 1 |") {
		t.Errorf("table:\n%s", table)
	}
}

// A dry run's row: the readings' tokens at the model's price, a local model
// free, Jev's calls at their measured cost, per cart.
func TestEstimatedRow(t *testing.T) {
	est := Estimate{LLM: 2, Jev: 4, LLMTokens: 2000, OutputTokens: 100}
	price := Price{Prompt: 1e-7, Completion: 5e-7, StructuredOutputs: true}
	row := EstimatedRow(Row{Variant: "luna-low"}, est, 2, price)
	want := (2000*1e-7 + 100*5e-7 + 4*JevCallUSD) / 2
	if !row.Estimated || row.CostPerCart != want || row.LLMCalls != 1 || row.JevCalls != 2 {
		t.Errorf("row %+v, want cost %v", row, want)
	}
	local := EstimatedRow(Row{Variant: "local", Local: true}, est, 2, price)
	if local.CostPerCart != 4*JevCallUSD/2 {
		t.Errorf("local %+v: free but for Jev", local)
	}
	if table := Table([]Row{row, local}); !strings.Contains(table, "≈ cost / cart") || !strings.Contains(table, "| local |  (local) |") {
		t.Errorf("table:\n%s", table)
	}
}

// OpenRouter's models API gives each model's price and whether it answers
// under a strict schema.
func TestFetchPrices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"openai/gpt-6-luna","pricing":{"prompt":"0.0000001","completion":"0.0000005"},` +
			`"supported_parameters":["response_format","structured_outputs"]},{"id":"qwen/qwen3.7-flash","pricing":{"prompt":"0.00000003",` +
			`"completion":"0.00000013"},"supported_parameters":["response_format"]}]}`))
	}))
	t.Cleanup(srv.Close)
	prices, err := FetchPrices(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if p := prices["openai/gpt-6-luna"]; p.Prompt != 1e-7 || p.Completion != 5e-7 || !p.StructuredOutputs {
		t.Errorf("luna %+v", p)
	}
	if prices["qwen/qwen3.7-flash"].StructuredOutputs {
		t.Error("qwen3.7-flash has no structured outputs")
	}
}
