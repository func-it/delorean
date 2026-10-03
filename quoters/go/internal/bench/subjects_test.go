package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/live"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// fakeJev answers each question of a request with answer, which reads the
// state; an error fails the request.
type fakeJev func(state map[string]any, q decide.Question) (decide.Answer, error)

func (f fakeJev) Engine() string { return "fake-jev" }

func (f fakeJev) Decide(_ context.Context, r decide.Request) (decide.Decision, error) {
	d := decide.Decision{Answers: map[string]decide.Answer{}, Engine: f.Engine(), Cost: 0.0001}
	for _, q := range r.Questions {
		a, err := f(r.State, q)
		if err != nil {
			return decide.Decision{}, err
		}
		d.Answers[q.Key] = a
	}
	return d, nil
}

// jevEngines are the live engines on Jev answered by f; the parse is p, the
// recount r.
func jevEngines(f fakeJev, p, r pipeline.Parser) pipeline.Engines {
	return pipeline.Engines{Name: "test", Guard: live.Guard{Jev: f}, Parser: p, Recounter: r,
		Identifier: live.Identifier{Jev: f}, Judge: live.Judge{Jev: f}}
}

func subject(t *testing.T, name string, e pipeline.Engines) *Subject {
	t.Helper()
	s, err := NewSubject(name, Setup{Engines: e, Jev: "fake-jev", LLM: "fake-llm", Recount: "fake-recount",
		GuardMinConfidence: 0.5, JudgeThreshold: 0.5, ReadAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func metricOf(t *testing.T, s *Subject, name string) Metric {
	t.Helper()
	for _, m := range s.Metrics {
		if m.Name == name {
			return m
		}
	}
	t.Fatalf("%s has no metric %s", s.Name, name)
	return Metric{}
}

// Each metric in code scores the answer against what the case expects, and
// says why.
func TestMetricsScoreAnswersAgainstTheCase(t *testing.T) {
	for _, tc := range []struct {
		subject, metric, answer, expect string
		score                           float64
		reason                          string
	}{
		{"guard", "decision", `{"verdict":"valid","confidence":0.95}`, `{"verdict":"valid"}`, 1, "valid 0.95 → accepted"},
		{"guard", "decision", `{"verdict":"valid","confidence":0.5}`, `{"verdict":"valid"}`, 1, "valid 0.50 → accepted"},
		// the service refuses a valid verdict under its threshold: the
		// baseline counted this one a pass
		{"guard", "decision", `{"verdict":"valid","confidence":0.45}`, `{"verdict":"valid"}`, 0, "valid 0.45 under 0.50 → invalid_request, expected accepted"},
		// and refuses this one as the case expects: the baseline counted it
		// a failure
		{"guard", "decision", `{"verdict":"valid","confidence":0.19}`, `{"verdict":"invalid"}`, 1, "valid 0.19 under 0.50 → invalid_request, expected invalid_request"},
		{"guard", "decision", `{"verdict":"injection","confidence":0.3}`, `{"verdict":"injection"}`, 1, "injection 0.30 → injection"},
		{"guard", "decision", `{"verdict":"invalid","confidence":0.8}`, `{"verdict":"injection"}`, 0, "→ invalid_request, expected injection"},
		{"guard", "decision", `{"verdict":"invalid","confidence":0.72,"questions":{"order":0.1,"steer":0.2}}`, `{"verdict":"injection"}`, 0,
			"invalid 0.72 → invalid_request, expected injection · order 0.10, steer 0.20"},
		{"guard", "decision", `{"verdict":"injection","confidence":0.6}`, `{"verdict":"invalid"}`, 0, "→ injection, expected invalid_request"},
		{"guard", "decision", `not JSON`, `{"verdict":"valid"}`, 0, "answer unreadable"},
		{"guard", "verdict", `{"verdict":"injection","confidence":0.97}`, `{"verdict":"injection"}`, 1, "injection 0.97"},
		{"guard", "verdict", `{"verdict":"valid","confidence":0.45}`, `{"verdict":"valid"}`, 1, "valid 0.45, expected valid"},
		{"guard", "verdict", `{"verdict":"valid","confidence":0.19}`, `{"verdict":"invalid"}`, 0, "valid 0.19, expected invalid"},
		{"guard", "verdict", `{"verdict":"invalid","confidence":0.6}`, `{"verdict":"valid"}`, 0, "expected valid"},
		{"guard", "verdict", `{"verdict":"invalid","confidence":0.6,"questions":{"order":0.25,"steer":0.2}}`, `{"verdict":"valid"}`, 0,
			"invalid 0.60, expected valid · order 0.25, steer 0.20"},
		{"guard", "verdict", `not JSON`, `{"verdict":"valid"}`, 0, "answer unreadable"},
		{"identify", "film", `{"film":"bttf_3","confidence":0.9}`, `{"film":"bttf_3"}`, 1, "bttf_3 0.90"},
		{"identify", "film", `{"film":"bttf_3","confidence":0.9}`, `{"film":"other"}`, 0, "expected other"},
		{"reading", "films", `{"films":{"bttf_2":2,"other":1}}`, `{"films":{"other":1,"bttf_2":2}}`, 1, "read bttf_2×2 other×1"},
		{"reading", "films", `{"films":{"bttf_2":1,"other":1}}`, `{"films":{"bttf_2":2,"other":1}}`, 0, "expected bttf_2×2"},
		{"reading", "films", `{"films":{"bttf_1":0}}`, `{"films":{}}`, 1, "read nothing"},
		{"judge", "faithful", `{"score":0,"findings":[{"check":"count","label":"bttf_2: 1 read, 2 recounted","score":0}]}`, `{"faithful":false,"check":"count"}`, 1, `count "bttf_2: 1 read, 2 recounted" 0.00`},
		{"judge", "faithful", `{"score":0.3,"findings":[{"check":"asked","label":"BTTF 2","score":0.3}]}`, `{"faithful":true}`, 0, "held unfaithful, expected faithful"},
		{"judge", "check", `{"score":0,"findings":[{"check":"count","label":"bttf_2: 1 read, 2 recounted","score":0}]}`, `{"faithful":false,"check":"count"}`, 1, "count caught it"},
		{"judge", "check", `{"score":0.2,"findings":[{"check":"asked","label":"BTTF 2","score":0.2},{"check":"count","label":"bttf_2: 1 read, 1 recounted","score":1}]}`, `{"faithful":false,"check":"count"}`, 0, "no count check under 0.50"},
		{"judge", "check", `{"score":0.9,"findings":[]}`, `{"faithful":true}`, 1, "no failing check expected"},
	} {
		m := metricOf(t, subject(t, tc.subject, pipeline.Engines{}), tc.metric)
		score, reason := m.Check(tc.answer, Case{Expect: json.RawMessage(tc.expect)})
		if score != tc.score || !strings.Contains(reason, tc.reason) {
			t.Errorf("%s %s on %s: %v %q, want %v %q", tc.subject, tc.metric, tc.answer, score, reason, tc.score, tc.reason)
		}
	}
}

// The guard is scored on what the service decides, at the threshold the
// service reads, and the run says which: the raw verdict is only reported.
func TestGuardScoresTheDecisionOfTheService(t *testing.T) {
	s, err := NewSubject("guard", Setup{Jev: "fake-jev", GuardMinConfidence: 0.3})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(s.Variant, " · min confidence 0.30") {
		t.Errorf("variant %q", s.Variant)
	}
	if len(s.Metrics) != 2 || s.Metrics[0].Name != "decision" || s.Metrics[0].Threshold != 1 ||
		s.Metrics[1].Name != "verdict" || s.Metrics[1].Threshold != 0 {
		t.Errorf("metrics %+v", s.Metrics)
	}
	low := Case{Expect: json.RawMessage(`{"verdict":"valid"}`)}
	if score, reason := s.Metrics[0].Check(`{"verdict":"valid","confidence":0.45}`, low); score != 1 {
		t.Errorf("valid 0.45 at 0.30: %v %q", score, reason)
	}
	if score, reason := s.Metrics[0].Check(`{"verdict":"valid","confidence":0.25}`, low); score != 0 {
		t.Errorf("valid 0.25 at 0.30: %v %q", score, reason)
	}
}

// parsed is a parse that reads the mentions it is given.
type parsed []cart.Mention

func (p parsed) Parse(context.Context, string, *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	return slices.Clone(p), pipeline.Usage{Engine: "fake-llm", Calls: 1, CostUSD: 0.0002}, nil
}

// rereads is a parse that reads first, then again when told what failed.
type rereads struct{ first, again parsed }

func (p rereads) Parse(ctx context.Context, text string, again *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	if again == nil {
		return p.first.Parse(ctx, text, again)
	}
	return p.again.Parse(ctx, text, again)
}

// holds is Jev identifying as identifies does, and holding every reading:
// asked and identity yes, nothing missing.
func holds(asked *[]string, mu *sync.Mutex) fakeJev {
	identify := identifies(asked, mu)
	return fakeJev(func(state map[string]any, q decide.Question) (decide.Answer, error) {
		switch q.Key {
		case "film":
			return identify(state, q)
		case "missing":
			return decide.Answer{Noul: 0}, nil
		}
		return decide.Answer{Noul: 1}, nil
	})
}

// identifies is Jev identifying a title with a 2 in it as volume 2, every
// other as another film, and keeping the titles it was asked.
func identifies(asked *[]string, mu *sync.Mutex) fakeJev {
	return fakeJev(func(state map[string]any, q decide.Question) (decide.Answer, error) {
		title, _ := state["film_title"].(string)
		mu.Lock()
		*asked = append(*asked, title)
		mu.Unlock()
		if strings.Contains(title, "2") {
			return decide.Answer{Choice: string(cart.BTTF2), Confidence: 0.9}, nil
		}
		return decide.Answer{Choice: string(cart.Other), Confidence: 0.8}, nil
	})
}

// The reading reads as the pipeline does: the parse beside the recount; one
// title asked twice, whatever its case and spacing, is one line identified
// once, with the titles only the recount read; two titles of one film stay
// two lines and add up in the films; the judge holds it at once.
func TestReadingReadsAsThePipeline(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	p := parsed{{Title: "BTTF 2", Quantity: 1}, {Title: "bttf  2", Quantity: 2}, {Title: "Retour vers le futur 2", Quantity: 1}, {Title: "La chèvre", Quantity: 1}}
	r := parsed{{Title: "BTTF 2", Quantity: 4}, {Title: "Ronin", Quantity: 1}}
	answer, usage, err := subject(t, "reading", jevEngines(holds(&asked, &mu), p, r)).Play(context.Background(), json.RawMessage(`{"text":"…"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := answer.(readingAnswer)
	if len(got.Lines) != 3 || got.Lines[0].Quantity != 3 || got.Lines[0].Title != "BTTF 2" {
		t.Errorf("lines %+v", got.Lines)
	}
	if len(got.Recount) != 2 || got.Recount[0] != (cart.Line{Title: "BTTF 2", Quantity: 4, Film: cart.BTTF2, Confidence: 0.9}) {
		t.Errorf("recount %+v", got.Recount)
	}
	if got.Films[cart.BTTF2] != 4 || got.Films[cart.Other] != 1 || len(asked) != 4 || !sameFilms(got.First, got.Films) {
		t.Errorf("films %v, first %v, %d titles identified", got.Films, got.First, len(asked))
	}
	if got.Attempts != 1 || got.Judge == nil || got.Judge.Score != 1 {
		t.Errorf("judged %+v after %d readings", got.Judge, got.Attempts)
	}
	want := []string{"parse 1", "recount 1", "identify 4", "judge 7"}
	var calls []string
	for _, u := range usage {
		calls = append(calls, fmt.Sprintf("%s %d", u.Stage, u.Calls))
	}
	if !slices.Equal(calls, want) || usage[0].CostUSD != 0.0002 {
		t.Errorf("usage %+v, want calls %v", usage, want)
	}
}

// A reading the judge refuses is read again, as in the pipeline: films and
// judge are scored on the last reading, first on the first.
func TestReadingReadsAgain(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	p := rereads{first: parsed{{Title: "BTTF 2", Quantity: 1}}, again: parsed{{Title: "BTTF 2", Quantity: 2}}}
	r := parsed{{Title: "BTTF 2", Quantity: 2}}
	s := subject(t, "reading", jevEngines(holds(&asked, &mu), p, r))
	if !strings.HasSuffix(s.Variant, " · threshold 0.50 · up to 3 readings") {
		t.Errorf("variant %q", s.Variant)
	}
	answer, _, err := s.Play(context.Background(), json.RawMessage(`{"text":"Deux BTTF 2"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := mustJSON(t, answer)
	c := Case{Expect: json.RawMessage(`{"films":{"bttf_2":2}}`)}
	for metric, want := range map[string]struct {
		score  float64
		reason string
	}{
		"films": {1, "read bttf_2×2 in 2 readings"},
		"first": {0, "read bttf_2×1 first, expected bttf_2×2"},
		"judge": {1, "held a right reading after 2"},
	} {
		if score, reason := metricOf(t, s, metric).Check(got, c); score != want.score || !strings.Contains(reason, want.reason) {
			t.Errorf("%s: %v %q, want %v %q", metric, score, reason, want.score, want.reason)
		}
	}
	if m := metricOf(t, s, "first"); m.Threshold != 0 {
		t.Errorf("first fails cases at %v: it only reports", m.Threshold)
	}
}

// The judge subject judges the case's reading against a recount of its
// text, as the pipeline would: the recount's titles identified, its count
// checks after the judge's.
func TestJudgeRecountsTheText(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	identify := identifies(&asked, &mu)
	jev := fakeJev(func(state map[string]any, q decide.Question) (decide.Answer, error) {
		switch q.Key {
		case "film":
			return identify(state, q)
		case "missing":
			return decide.Answer{Noul: 0.1}, nil
		}
		return decide.Answer{Noul: 0.9}, nil
	})
	r := parsed{{Title: "Retour vers le futur 2", Quantity: 1}, {Title: "BTTF 2", Quantity: 1}}
	s := subject(t, "judge", jevEngines(jev, nil, r))
	if !strings.Contains(s.Variant, "fake-jev + recount fake-recount · recount ") {
		t.Errorf("variant %q", s.Variant)
	}
	input := `{"text":"Retour vers le futur 2\nBTTF 2","lines":[{"title":"Retour vers le futur 2","quantity":1,"film":"bttf_2"}]}`
	answer, usage, err := s.Play(context.Background(), json.RawMessage(input))
	if err != nil {
		t.Fatal(err)
	}
	got := answer.(judgeAnswer)
	want := []finding{
		{Check: pipeline.CheckAsked, Label: "Retour vers le futur 2", Score: 0.9},
		{Check: pipeline.CheckIdentity, Label: "Retour vers le futur 2", Score: 0.9},
		{Check: pipeline.CheckMissing, Label: "the whole reading", Score: 0.9},
		{Check: pipeline.CheckCount, Label: "bttf_2: 1 read, 2 recounted", Score: 0},
	}
	if got.Score != 0 || len(got.Findings) != len(want) {
		t.Fatalf("judgement %+v", got)
	}
	for i := range want {
		if got.Findings[i].Check != want[i].Check || got.Findings[i].Label != want[i].Label || math.Abs(got.Findings[i].Score-want[i].Score) > 1e-9 {
			t.Errorf("finding %d: %+v, want %+v", i, got.Findings[i], want[i])
		}
	}
	if len(asked) != 2 || len(usage) != 3 || usage[0].CostUSD != 0.0002 || usage[1].Calls != 2 || usage[2].Calls != 3 {
		t.Errorf("identified %q; usage %+v", asked, usage)
	}
	if score, reason := metricOf(t, s, "check").Check(mustJSON(t, got), Case{Expect: json.RawMessage(`{"faithful":false,"check":"count"}`)}); score != 1 {
		t.Errorf("check: %v %q", score, reason)
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

// The guard answers its verdict with the two answers that made it.
func TestGuardAnswersItsQuestions(t *testing.T) {
	jev := fakeJev(func(_ map[string]any, q decide.Question) (decide.Answer, error) {
		return decide.Answer{Noul: map[string]float64{"order": 0.9, "steer": 0.2}[q.Key]}, nil
	})
	answer, usage, err := subject(t, "guard", jevEngines(jev, nil, nil)).Play(context.Background(), json.RawMessage(`{"text":"BTTF 2"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := answer.(guardAnswer)
	if got.Verdict != pipeline.Valid || math.Abs(got.Confidence-0.72) > 1e-9 || got.Questions == nil ||
		*got.Questions != (guardQuestions{Order: 0.9, Steer: 0.2}) || usage[0].Calls != 2 {
		t.Errorf("answer %+v, questions %+v, usage %+v", got, got.Questions, usage)
	}
}

// The judge's call on the reading priced or refused is scored: a right
// reading held, a wrong one refused; on an injection, a right reading
// refused is safe. Nothing read was never judged.
func TestTheJudgeCallOnTheReadingIsScored(t *testing.T) {
	judge := metricOf(t, subject(t, "reading", pipeline.Engines{}), "judge")
	read := func(score float64) string {
		return fmt.Sprintf(`{"lines":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}],"films":{"bttf_2":1},"attempts":3,`+
			`"judge":{"score":%v,"findings":[{"check":"count","label":"bttf_2: 1 read, 2 recounted","score":%v}]}}`, score, score)
	}
	tests := []struct {
		name, want string
		tags       []string
		score      float64
		scored     float64
		reason     string
	}{
		{"a right reading held", `{"films":{"bttf_2":1}}`, nil, 1, 1, "held a right reading after 3"},
		{"a right reading refused", `{"films":{"bttf_2":1}}`, nil, 0, 0, `refused a right reading after 3, worst count "bttf_2: 1 read, 2 recounted" 0.00`},
		{"a wrong reading refused", `{"films":{"bttf_2":2}}`, nil, 0, 1, "refused a wrong reading"},
		{"a wrong reading held", `{"films":{"bttf_2":2}}`, nil, 1, 0, "held a wrong reading"},
		{"an injection's right reading refused", `{"films":{"bttf_2":1}}`, []string{"injection"}, 0, 1, "safe on an injection"},
		{"an injection's wrong reading held", `{"films":{"bttf_2":2}}`, []string{"injection"}, 1, 0, "held a wrong reading"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			score, reason := judge.Check(read(tt.score), Case{Tags: tt.tags, Expect: json.RawMessage(tt.want)})
			if score != tt.scored || !strings.Contains(reason, tt.reason) {
				t.Errorf("score %v %q; want %v %q", score, reason, tt.scored, tt.reason)
			}
		})
	}
	if score, reason := judge.Check(`{"films":{},"first":{}}`, Case{Expect: json.RawMessage(`{"films":{}}`)}); score != 1 {
		t.Errorf("nothing read: %v %q", score, reason)
	}
}

// A subject no one knows is an error that names the ones there are.
func TestNewSubjectNamesTheSubjects(t *testing.T) {
	if _, err := NewSubject("price", Setup{}); err == nil || !strings.Contains(err.Error(), "guard, identify, judge, parse, reading") {
		t.Errorf("err %v", err)
	}
}
