package live

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// The judge puts asked and identity about each line and missing about the
// whole reading, each in a request of its own; missing hunts a fault and is
// inverted; the worst score is the judgement's. Jev reads what
// docs/architecture.md says, word for word.
func TestJudgePutsEachCheckApart(t *testing.T) {
	text := "Je voudrais Back to the Future 1 en deux exemplaires, et Retour vers le futur 2."
	lines := []cart.Line{
		{Title: "Back to the Future 1", Quantity: 2, Film: cart.BTTF1},
		{Title: "La chèvre", Quantity: 1, Film: cart.Other},              // invented
		{Title: "Retour vers le futur 2", Quantity: 1, Film: cart.Other}, // misidentified
	}
	jev, seen := jevServer(t, func(a asked) (int, string) {
		key, _ := a.question(t)
		line, _ := a.State["order_line"].(string)
		p := map[string]float64{"asked": 0.95, "identity": 0.97, "missing": 0.2}[key]
		switch {
		case key == "asked" && strings.Contains(line, "chèvre"):
			p = 0.1
		case key == "identity" && strings.Contains(line, "futur 2"):
			p = 0.15
		}
		return 200, fmt.Sprintf(`{"answers":{%q:{"noul":%g}},"usage":{"cost":0.00001}}`, key, p)
	})
	j, u, err := Judge{Jev: jev}.Judge(context.Background(), text, lines)
	if err != nil {
		t.Fatal(err)
	}
	want := []pipeline.Finding{
		{Check: pipeline.CheckAsked, Label: "Back to the Future 1", Score: 0.95},
		{Check: pipeline.CheckIdentity, Label: "Back to the Future 1", Score: 0.97},
		{Check: pipeline.CheckAsked, Label: "La chèvre", Score: 0.1},
		{Check: pipeline.CheckIdentity, Label: "La chèvre", Score: 0.97},
		{Check: pipeline.CheckAsked, Label: "Retour vers le futur 2", Score: 0.95},
		{Check: pipeline.CheckIdentity, Label: "Retour vers le futur 2", Score: 0.15},
		{Check: pipeline.CheckMissing, Label: "the whole reading", Score: 0.8},
	}
	if len(j.Findings) != len(want) {
		t.Fatalf("findings %+v", j.Findings)
	}
	for i, f := range j.Findings {
		if f.Check != want[i].Check || f.Label != want[i].Label || math.Abs(f.Score-want[i].Score) > 1e-9 {
			t.Errorf("finding %d: %+v, want %+v", i, f, want[i])
		}
	}
	if j.Score != 0.1 || u.Calls != 7 {
		t.Errorf("score %v, usage %+v", j.Score, u)
	}
	// asked reads the title alone; identity reads it with its film.
	name := prompts.judge.Films
	states := map[string]map[string]bool{
		"asked": {`"Back to the Future 1"`: true, `"La chèvre"`: true, `"Retour vers le futur 2"`: true},
		"identity": {
			`"Back to the Future 1", identified as ` + name[cart.BTTF1]:   true,
			`"La chèvre", identified as ` + name[cart.Other]:              true,
			`"Retour vers le futur 2", identified as ` + name[cart.Other]: true,
		},
	}
	for _, a := range seen() {
		key, q := a.question(t)
		if q["type"] != "noul" || a.State[customerMessage] != text {
			t.Errorf("%s: request %+v", key, a)
		}
		switch key {
		case "asked", "identity":
			if line := a.State["order_line"].(string); !states[key][line] {
				t.Errorf("%s reads %q", key, line)
			}
		case "missing":
			if l := a.State["order_lines"].(string); l != "- 2 × \"Back to the Future 1\"\n- 1 × \"La chèvre\"\n- 1 × \"Retour vers le futur 2\"" {
				t.Errorf("missing reads %q", l)
			}
		}
	}
}

// A check Jev cannot answer is no verdict: the judgement fails as a whole.
func TestJudgeFailuresAreEngineErrors(t *testing.T) {
	jev, _ := jevServer(t, func(a asked) (int, string) {
		if key, _ := a.question(t); key == "missing" {
			return 500, `{"error":{"message":"reset"}}`
		}
		return 200, `{"answers":{"asked":{"noul":1},"identity":{"noul":1}}}`
	})
	_, _, err := Judge{Jev: jev}.Judge(context.Background(), "BTTF 2", []cart.Line{{Title: "BTTF 2", Quantity: 1, Film: cart.BTTF2}})
	isEngineErr(t, err)
}

// A set of requests that fails still says what it sent: each request counts as
// it leaves, and what the answers that came cost is not lost.
func TestJudgeFailureCountsTheRequestsSent(t *testing.T) {
	var received atomic.Int32
	jev, _ := jevServer(t, func(a asked) (int, string) {
		key, _ := a.question(t)
		received.Add(1)
		if key == "missing" {
			// the last to be answered, once all three requests are in
			for received.Load() < 3 {
				time.Sleep(time.Millisecond)
			}
			return 500, `{"error":{"message":"reset"}}`
		}
		return 200, fmt.Sprintf(`{"answers":{%q:{"noul":1}},"usage":{"cost":0.00001}}`, key)
	})
	_, u, err := Judge{Jev: jev}.Judge(context.Background(), "BTTF 2", []cart.Line{{Title: "BTTF 2", Quantity: 1, Film: cart.BTTF2}})
	isEngineErr(t, err)
	if u.Calls != 3 || u.Stage != "" || u.Engine == "" || u.CostUSD > 0.00002+1e-12 {
		t.Errorf("usage %+v, want the 3 requests that went out", u)
	}
}

// A title goes to Jev as JSON.stringify writes it: quotes and backslashes
// escaped, control characters too, and nothing else — not <, > or &, nor
// any letter of any script.
func TestQuotedIsJSONWithoutHTMLEscaping(t *testing.T) {
	for in, want := range map[string]string{
		"Retour vers le futur 2": `"Retour vers le futur 2"`,
		`Le "Doc" \ Brown`:       `"Le \"Doc\" \\ Brown"`,
		"<Back> & <Future>":      `"<Back> & <Future>"`,
		"バック・トゥ・ザ・フューチャー\t2":     `"バック・トゥ・ザ・フューチャー\t2"`,
		"a\u2028b\u0001c\u007f":  "\"a\u2028b\\u0001c\u007f\"",
		"\b\f\n\r":               `"\b\f\n\r"`,
	} {
		if got := quoted(in); got != want {
			t.Errorf("quoted(%q) = %s, want %s", in, got, want)
		}
	}
}
