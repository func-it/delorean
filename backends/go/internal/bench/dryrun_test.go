package bench

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/bn-k/delorean/backends/go/internal/prepare"
)

// A dry run counts, offline, the calls a pass would make: one Jev request
// per guard or identify case, 3 per line plus 1 per judge case, and for a
// reading one parse, its identifications and the judge's checks.
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

	for _, name := range []string{"guard", "identify"} {
		cases := load(name)
		if est := estimate(name, cases); est.Jev != len(cases) || est.LLM != 0 || est.Approximate {
			t.Errorf("%s: %+v for %d cases", name, est, len(cases))
		}
	}

	cases, checks := load("judge"), 0
	for _, c := range cases {
		var in judgeInput
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		checks += 3*len(in.Lines) + 1
	}
	if est := estimate("judge", cases); est.Jev != checks {
		t.Errorf("judge: %d Jev calls, want %d", est.Jev, checks)
	}

	cases = load("reading")
	if est := estimate("reading", cases); est.LLM != len(cases) || est.Jev <= len(cases) || !est.Approximate {
		t.Errorf("reading: %+v for %d cases", est, len(cases))
	}
}
