package bench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Variant is one way to configure the service, which a matrix benches
// beside the others: a name, and environment overrides on top of the
// service's own configuration. One code, configured: no fork.
type Variant struct {
	Name string            `yaml:"name"`
	Note string            `yaml:"note,omitempty"`
	Env  map[string]string `yaml:"env"`
}

// variantName is what a variant's name may be: it names a report file and a
// Langfuse experiment.
var variantName = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*$`)

// LoadVariants reads a variants file: {variants: [{name, note?, env}]}, each
// name unique.
func LoadVariants(path string) ([]Variant, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f struct {
		Variants []Variant `yaml:"variants"`
	}
	dec := yaml.NewDecoder(strings.NewReader(string(b)))
	dec.KnownFields(true)
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(f.Variants) == 0 {
		return nil, fmt.Errorf("%s: no variant", path)
	}
	seen := map[string]bool{}
	var errs []error
	for i, v := range f.Variants {
		switch {
		case !variantName.MatchString(v.Name):
			errs = append(errs, fmt.Errorf("%s: variant %d: name %q, want lowercase letters, digits, dots and dashes", path, i+1, v.Name))
		case seen[v.Name]:
			errs = append(errs, fmt.Errorf("%s: variant %q twice", path, v.Name))
		}
		seen[v.Name] = true
	}
	return f.Variants, errors.Join(errs...)
}

// Row is one variant in the comparison of a matrix: what it is, how often it
// read right, how long the parse took, and what a cart cost.
type Row struct {
	Variant  string `json:"variant"`
	Model    string `json:"model"`
	Effort   string `json:"effort"`
	Strategy string `json:"strategy"`
	// Local says the model answers on this machine: no bill.
	Local bool `json:"local"`
	// Passed and Scored are the runs of the subject's first metric
	// (films), over every case.
	Passed      int `json:"passed"`
	Scored      int `json:"scored"`
	CasesFailed int `json:"cases_failed"`
	// P50 and P90 are the parse stage's latency, in ms.
	P50 int64 `json:"p50_ms"`
	P90 int64 `json:"p90_ms"`
	// CostPerCart is the mean cost of a cart's plays — parse and identify —
	// in USD.
	CostPerCart float64 `json:"cost_per_cart_usd"`
	Errors      int     `json:"errors"`
	// Estimated says the row is a dry run's: a cost estimated from the
	// token counts and the models' prices, nothing measured.
	Estimated bool `json:"estimated,omitempty"`
	// CutShort says the spend reached the cap: some plays, or the whole
	// variant, were not run.
	CutShort bool `json:"cut_short,omitempty"`
	// Calls are the model calls a cart takes, when estimated.
	LLMCalls float64 `json:"llm_calls_per_cart,omitempty"`
	JevCalls float64 `json:"jev_calls_per_cart,omitempty"`
}

// RowOf reads a run's report and stats into the row of variant v, whose
// model, effort, strategy and locality row carries already.
func RowOf(row Row, rep *Report, sum Summary) Row {
	metric := ""
	if len(rep.Metrics) > 0 {
		metric = rep.Metrics[0]
	}
	for _, id := range rep.Cases {
		failed := false
		for _, sc := range rep.Scores[id] {
			if sc.Skipped { // not played: the spend reached the cap
				continue
			}
			score, ok := sc.Scores[metric]
			if !ok {
				failed = true
				continue
			}
			row.Scored++
			if score >= rep.Thresholds[metric] {
				row.Passed++
			} else {
				failed = true
			}
		}
		if failed {
			row.CasesFailed++
		}
	}
	parse := sum.Stages[pipeline.StageParse]
	row.P50, row.P90 = parse.P50, parse.P90
	if carts := sum.Plays + sum.Failed; carts > 0 {
		row.CostPerCart = sum.Cost / float64(carts)
	}
	row.Errors = sum.Failed
	row.CutShort = rep.CutShort
	return row
}

// JevCallUSD is what one Jev decision costs, as measured on the benches
// (docs/testing.md, Cost): the models API does not price Jev, which is not
// on chat completions.
const JevCallUSD = 0.00003

// Price is what a model costs on OpenRouter, in USD a token, and whether it
// can answer under a strict JSON schema.
type Price struct {
	Prompt, Completion float64
	StructuredOutputs  bool
}

// FetchPrices reads OpenRouter's models API (a GET, no key, no cost): each
// model's price and whether it supports structured outputs.
func FetchPrices(ctx context.Context, url string) (map[string]Price, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	rsp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer rsp.Body.Close()
	if rsp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models API: status %d", rsp.StatusCode)
	}
	var body struct {
		Data []struct {
			ID      string `json:"id"`
			Pricing struct {
				Prompt     string `json:"prompt"`
				Completion string `json:"completion"`
			} `json:"pricing"`
			Supported []string `json:"supported_parameters"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rsp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("models API: %w", err)
	}
	out := make(map[string]Price, len(body.Data))
	for _, m := range body.Data {
		var p Price
		_, _ = fmt.Sscan(m.Pricing.Prompt, &p.Prompt)
		_, _ = fmt.Sscan(m.Pricing.Completion, &p.Completion)
		for _, s := range m.Supported {
			if s == "structured_outputs" {
				p.StructuredOutputs = true
			}
		}
		out[m.ID] = p
	}
	return out, nil
}

// EstimatedRow is a dry run's row for a variant: the cost of a cart from
// its estimate — the readings' tokens at the model's price, nothing for a
// local model, and Jev's calls at JevCallUSD — over cases carts.
func EstimatedRow(row Row, est Estimate, cases int, price Price) Row {
	row.Estimated = true
	if cases == 0 {
		return row
	}
	llm := float64(est.LLMTokens)*price.Prompt + float64(est.OutputTokens)*price.Completion
	if row.Local {
		llm = 0
	}
	row.CostPerCart = (llm + float64(est.Jev)*JevCallUSD) / float64(cases)
	row.LLMCalls = float64(est.LLM) / float64(cases)
	row.JevCalls = float64(est.Jev) / float64(cases)
	return row
}

// Table is the comparison of a matrix in Markdown, a row a variant.
func Table(rows []Row) string {
	var b strings.Builder
	dry := len(rows) > 0 && rows[0].Estimated
	if dry {
		b.WriteString("| variant | model | effort | strategy | LLM calls / cart | Jev calls / cart | ≈ cost / cart | ≈ cost / 1,000 carts |\n")
		b.WriteString("|---|---|---|---|---:|---:|---:|---:|\n")
	} else {
		b.WriteString("| variant | model | effort | strategy | accuracy | cases failed | p50 | p90 | cost / cart | cost / 1,000 carts | errors |\n")
		b.WriteString("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n")
	}
	for _, r := range rows {
		model := r.Model
		if r.Local {
			model += " (local)"
		}
		if dry {
			fmt.Fprintf(&b, "| %s | %s | %s | %s | %.1f | %.1f | $%.6f | $%.3f |\n",
				r.Variant, model, r.Effort, r.Strategy, r.LLMCalls, r.JevCalls, r.CostPerCart, r.CostPerCart*1000)
			continue
		}
		accuracy := "—"
		if r.Scored > 0 {
			accuracy = fmt.Sprintf("%d / %d (%.0f %%)", r.Passed, r.Scored, 100*float64(r.Passed)/float64(r.Scored))
		}
		if r.CutShort {
			accuracy += " — cut short"
		}
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %d | %d ms | %d ms | $%.6f | $%.3f | %d |\n",
			r.Variant, model, r.Effort, r.Strategy, accuracy, r.CasesFailed, r.P50, r.P90, r.CostPerCart, r.CostPerCart*1000, r.Errors)
	}
	return b.String()
}
