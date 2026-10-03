package main

import (
	"strings"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/bench"
)

// guardRun is one run of a guard case: its decision and verdict scores, and
// the answer the engine gave.
func guardRun(decision, verdict float64, answer string) bench.Scored {
	return bench.Scored{Passed: decision == 1, Answer: answer,
		Scores: map[string]float64{"decision": decision, "verdict": verdict}}
}

// row is the line of the table that starts with id, its cells split.
func row(t *testing.T, out, id string) []string {
	t.Helper()
	for l := range strings.SplitSeq(out, "\n") {
		if f := strings.Fields(l); len(f) > 0 && f[0] == id {
			return f[1:]
		}
	}
	t.Fatalf("no row %s in\n%s", id, out)
	return nil
}

// Each metric shows the runs it passed and its mean score, under a header
// that says it is a score; a metric only reported counts the runs it got
// right. The lowest confidence of each case shows beside, without Langfuse.
func TestReportShowsTheLowestConfidence(t *testing.T) {
	rep := &bench.Report{
		Runs:       []bench.RunResult{{Name: "r #1", PassRate: 1}, {Name: "r #2", PassRate: 0.5}, {Name: "r #3", PassRate: 0.5}},
		Cases:      []string{"order", "unsure"},
		Metrics:    []string{"decision", "verdict"},
		Thresholds: map[string]float64{"decision": 1, "verdict": 0},
		Scores: map[string][]bench.Scored{
			"order": {
				guardRun(1, 1, `{"verdict":"valid","confidence":0.95}`),
				guardRun(0, 1, `{"verdict":"valid","confidence":0.45}`),
				guardRun(1, 1, `{"verdict":"valid","confidence":0.8}`),
			},
			"unsure": {
				guardRun(1, 0, `{"verdict":"valid","confidence":0.19}`),
				guardRun(1, 0, `{"verdict":"valid","confidence":0.3}`),
				{}, // a play that failed
			},
		},
	}
	var out strings.Builder
	printReport(&out, &bench.Langfuse{BaseURL: "http://lf"}, rep)
	s := out.String()

	header := strings.Join(strings.Fields(strings.SplitN(strings.TrimLeft(s, "\n"), "\n", 2)[0]), " ")
	if header != "case decision mean score verdict mean score min conf passed" {
		t.Errorf("header %q", header)
	}
	for id, want := range map[string]string{
		"order":  "2/3 0.67 3/3 1.00 0.45 2/3",
		"unsure": "2/2 1.00 0/2 0.00 0.19 2/3",
	} {
		if got := strings.Join(row(t, s, id), " "); got != want {
			t.Errorf("%s: %q, want %q", id, got, want)
		}
	}
	for _, want := range []string{"a score, not the engine's confidence", "verdict: reported only", "min conf: the lowest confidence"} {
		if !strings.Contains(s, want) {
			t.Errorf("the report does not say %q:\n%s", want, s)
		}
	}
}

// Answers without a confidence, a reading's or a judge's, have no column
// for it.
func TestReportWithoutConfidence(t *testing.T) {
	rep := &bench.Report{
		Runs:       []bench.RunResult{{Name: "r", PassRate: 1}},
		Cases:      []string{"two-films"},
		Metrics:    []string{"films", "judge"},
		Thresholds: map[string]float64{"films": 1, "judge": 0.5},
		Scores: map[string][]bench.Scored{"two-films": {{Passed: true, Answer: `{"films":{"bttf_2":2}}`,
			Scores: map[string]float64{"films": 1, "judge": 0.83}}}},
	}
	var out strings.Builder
	printReport(&out, &bench.Langfuse{BaseURL: "http://lf"}, rep)
	if s := out.String(); strings.Contains(s, "min conf") || strings.Contains(s, "reported only") {
		t.Errorf("report:\n%s", s)
	}
	if got := strings.Join(row(t, out.String(), "two-films"), " "); got != "1/1 1.00 1/1 0.83 1/1" {
		t.Errorf("row %q", got)
	}
}
