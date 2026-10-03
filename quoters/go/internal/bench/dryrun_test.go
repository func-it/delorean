package bench

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/prepare"
)

// A dry run counts, offline, the calls a pass would make: two Jev requests
// per guard case, one per identify case; for a judge case the recount of its
// text, the identification of the titles it reads, and 2 checks per line
// plus 1; for a reading the parse and the recount, their identifications
// and the judge's checks.
func TestDryRunCountsWhatAPassSends(t *testing.T) {
	counter, err := prepare.NewCounter()
	if err != nil {
		t.Fatal(err)
	}
	load := func(name string) []Case {
		cases, err := Load(filepath.Join(repoCases, name))
		if err != nil {
			t.Fatal(err)
		}
		return cases
	}
	estimate := func(name string, cases []Case) Estimate {
		est, err := DryRun(context.Background(), name, Setup{Jev: "jev-1.13"}, cases, counter.Count)
		if err != nil {
			t.Fatal(err)
		}
		if est.Tokens <= 0 || est.Variant == "" {
			t.Errorf("%s: %+v", name, est)
		}
		return est
	}

	for name, perCase := range map[string]int{"guard": 2, "identify": 1} {
		cases := load(name)
		if est := estimate(name, cases); est.Jev != perCase*len(cases) || est.LLM != 0 || est.Approximate {
			t.Errorf("%s: %+v for %d cases", name, est, len(cases))
		}
	}

	cases, calls := load("judge"), 0
	for _, c := range cases {
		var in judgeInput
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		titles := map[string]bool{}
		for _, l := range in.Lines {
			titles[strings.ToLower(strings.Join(strings.Fields(l.Title), " "))] = true
		}
		calls += len(titles) + 2*len(in.Lines) + 1
	}
	if est := estimate("judge", cases); est.Jev != calls || est.LLM != len(cases) || !est.Approximate {
		t.Errorf("judge: %+v, want %d Jev calls and %d LLM", est, calls, len(cases))
	}

	cases = load("reading")
	if est := estimate("reading", cases); est.LLM != 2*len(cases) || est.Jev <= len(cases) || !est.Approximate {
		t.Errorf("reading: %+v for %d cases", est, len(cases))
	}

	// one reading a case is counted, the run's own setting named
	again, err := DryRun(context.Background(), "reading", Setup{Jev: "jev-1.13", ReadAttempts: 3}, cases, counter.Count)
	if err != nil || again.LLM != 2*len(cases) || again.ReadAttempts != 3 || !strings.HasSuffix(again.Variant, " · up to 3 readings") {
		t.Errorf("reading up to 3 readings: %+v, %v", again, err)
	}
	if est := estimate("judge", load("judge")); est.ReadAttempts != 0 {
		t.Errorf("judge reads again? %+v", est)
	}
}
