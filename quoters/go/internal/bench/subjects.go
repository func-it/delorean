package bench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/live"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
	"github.com/func-it/delorean/quoters/go/internal/prepare"
)

// Subjects are the component benches, by name — the folder of their cases
// and their Langfuse dataset — with what each tests.
var Subjects = map[string]string{
	"guard":    "The guard alone: is a text a cart (valid), an attempt to steer the system (injection), or neither (invalid)?",
	"identify": "One title as a customer wrote it, in any language or spelling: which film is it?",
	"reading":  "The pipeline's reading — parse beside the recount, identify, judge, read again while the judge refuses: the films a text buys, and how many copies of each.",
	"judge":    "The judge, with the recount it compares against: is a reading faithful to the text it was read from, and which check says it is not?",
	"parse":    "The first reading alone — the parse, then identify, on the reading cases: the films a text buys, what the parse costs and how long it takes.",
}

// Names are the subjects, sorted.
func Names() []string { return slices.Sorted(maps.Keys(Subjects)) }

// Setup is what the subjects are played with.
type Setup struct {
	Engines pipeline.Engines
	// Jev, LLM and Recount name the models behind the engines, for the
	// variant: "jev-1.13", "gpt-6-luna (low)", "deepseek-v4.1-flash (low)".
	Jev, LLM, Recount string
	// GuardMinConfidence is the least confidence of a valid verdict the
	// pipeline accepts; JudgeThreshold the worst score of the judge;
	// ReadAttempts the most readings of a cart.
	GuardMinConfidence float64
	JudgeThreshold     float64
	ReadAttempts       int
	// ParseIdentifies says the parse gives each line its film
	// (prompts/parse-films.json): its titles are not put to identify.
	ParseIdentifies bool
}

// Folder is the folder of a subject's cases: its own, but for parse, which
// reads the reading cases.
func Folder(subject string) string {
	if subject == "parse" {
		return "reading"
	}
	return subject
}

// NewSubject builds the subject called name on setup's engines. It calls
// nothing: the calls start with a run.
func NewSubject(name string, setup Setup) (*Subject, error) {
	desc, ok := Subjects[name]
	if !ok {
		return nil, fmt.Errorf("subject %q unknown (%s)", name, strings.Join(Names(), ", "))
	}
	s := &Subject{Name: name, Description: desc, Stats: &Stats{}}
	e, threshold := setup.Engines, setup.JudgeThreshold
	versions := func(stages ...pipeline.Stage) string {
		var out []string
		for _, st := range stages {
			out = append(out, fmt.Sprintf("%s %s", st, live.Version(st)))
		}
		return strings.Join(out, " · ")
	}
	switch name {
	case "guard":
		floor := setup.GuardMinConfidence
		s.Variant = setup.Jev + " · " + versions(pipeline.StageGuard) + fmt.Sprintf(" · min confidence %.2f", floor)
		s.Play = playGuard(e)
		s.Metrics = []Metric{
			{Name: "decision", Threshold: 1, Check: check(func(got guardAnswer, want guardExpect) (bool, string) {
				gave, wanted := decision(got.Verdict, got.Confidence, floor), decision(want.Verdict, 1, floor)
				why := fmt.Sprintf("%s %.2f", got.Verdict, got.Confidence)
				if got.Verdict == pipeline.Valid && got.Confidence < floor {
					why += fmt.Sprintf(" under %.2f", floor)
				}
				return gave == wanted, fmt.Sprintf("%s → %s, expected %s%s", why, gave, wanted, got.answers())
			})},
			// the raw verdict, what the first runs scored: kept to compare
			// with them, it fails no case
			{Name: "verdict", Threshold: 0, Check: check(func(got guardAnswer, want guardExpect) (bool, string) {
				return got.Verdict == want.Verdict,
					fmt.Sprintf("%s %.2f, expected %s%s", got.Verdict, got.Confidence, want.Verdict, got.answers())
			})},
		}
	case "identify":
		s.Variant = setup.Jev + " · " + versions(pipeline.StageIdentify)
		s.Play = playIdentify(e)
		s.Metrics = []Metric{{Name: "film", Threshold: 1, Check: check(func(got identifyAnswer, want identifyExpect) (bool, string) {
			return got.Film == want.Film, fmt.Sprintf("%s %.2f, expected %s", got.Film, got.Confidence, want.Film)
		})}}
	case "parse":
		strategy := "parse + identify"
		if setup.ParseIdentifies {
			strategy = "the parse identifies"
		}
		s.Variant = fmt.Sprintf("%s + %s · parse %s · identify %s · %s", setup.LLM, setup.Jev,
			live.ParseVersion(setup.ParseIdentifies), live.Version(pipeline.StageIdentify), strategy)
		s.Play = playParse(e)
		s.Metrics = []Metric{{Name: "films", Threshold: 1, Check: check(func(got readingAnswer, want readingExpect) (bool, string) {
			return sameFilms(got.Films, want.Films), fmt.Sprintf("read %s, expected %s", films(got.Films), films(want.Films))
		})}}
	case "reading":
		attempts := max(setup.ReadAttempts, 1)
		s.readAttempts = attempts
		s.Variant = setup.LLM + " + recount " + setup.Recount + " + " + setup.Jev + " · " +
			versions(pipeline.StageParse, pipeline.StageIdentify, pipeline.StageJudge) +
			fmt.Sprintf(" · threshold %.2f · up to %d readings", threshold, attempts)
		s.Play = playReading(&pipeline.Pipeline{Engines: e, JudgeThreshold: threshold, ReadAttempts: attempts})
		s.Metrics = []Metric{
			// the reading priced, or refused: the last
			{Name: "films", Threshold: 1, Check: check(func(got readingAnswer, want readingExpect) (bool, string) {
				return sameFilms(got.Films, want.Films), fmt.Sprintf("read %s in %d readings, expected %s",
					films(got.Films), got.Attempts, films(want.Films))
			})},
			// the first reading, what the pipeline read before any retry:
			// set against films, what reading again recovers. It fails no case.
			{Name: "first", Threshold: 0, Check: check(func(got readingAnswer, want readingExpect) (bool, string) {
				return sameFilms(got.First, want.Films), fmt.Sprintf("read %s first, expected %s", films(got.First), films(want.Films))
			})},
			{Name: "judge", Threshold: 1, Check: judgeCall(threshold)},
		}
	case "judge":
		s.Variant = setup.Jev + " + recount " + setup.Recount + " · " +
			versions(pipeline.StageRecount, pipeline.StageIdentify, pipeline.StageJudge) + fmt.Sprintf(" · threshold %.2f", threshold)
		s.Play = playJudge(e)
		s.Metrics = []Metric{
			{Name: "faithful", Threshold: 1, Check: check(func(got judgeAnswer, want judgeExpect) (bool, string) {
				held := got.Score >= threshold
				return held == want.Faithful, fmt.Sprintf("worst %.2f (%s), held %s, expected %s",
					got.Score, got.worst(), faithful(held), faithful(want.Faithful))
			})},
			{Name: "check", Threshold: 1, Check: check(func(got judgeAnswer, want judgeExpect) (bool, string) {
				if want.Faithful || want.Check == "" {
					return true, "no failing check expected"
				}
				for _, f := range got.Findings {
					if f.Check == want.Check && f.Score < threshold {
						return true, fmt.Sprintf("%s caught it: %q %.2f", f.Check, f.Label, f.Score)
					}
				}
				return false, fmt.Sprintf("no %s check under %.2f; worst %s", want.Check, threshold, got.worst())
			})},
		}
	}
	return s, nil
}

// check makes a metric's Check of f, which reads the answer and the case's
// expect decoded, and says whether they agree.
func check[A, E any](f func(got A, want E) (bool, string)) func(string, Case) (float64, string) {
	return func(answer string, c Case) (float64, string) {
		var got A
		var want E
		if err := json.Unmarshal([]byte(answer), &got); err != nil {
			return 0, "answer unreadable: " + err.Error()
		}
		if err := json.Unmarshal(c.Expect, &want); err != nil {
			return 0, "expect unreadable: " + err.Error()
		}
		ok, why := f(got, want)
		if !ok {
			return 0, why
		}
		return 1, why
	}
}

type (
	guardInput struct {
		Text string `json:"text"`
	}
	guardExpect struct {
		Verdict pipeline.Verdict `json:"verdict"`
	}
	guardAnswer struct {
		Verdict       pipeline.Verdict             `json:"verdict"`
		Confidence    float64                      `json:"confidence"`
		Probabilities map[pipeline.Verdict]float64 `json:"probabilities"`
		Questions     *guardQuestions              `json:"questions,omitempty"`
	}
	guardQuestions struct {
		Order float64 `json:"order"`
		Steer float64 `json:"steer"`
	}

	identifyInput struct {
		Title string `json:"title"`
	}
	identifyExpect struct {
		Film cart.Film `json:"film"`
	}
	identifyAnswer struct {
		Film          cart.Film             `json:"film"`
		Confidence    float64               `json:"confidence"`
		Probabilities map[cart.Film]float64 `json:"probabilities"`
	}

	readingInput struct {
		Text string `json:"text"`
	}
	readingExpect struct {
		Films map[cart.Film]int `json:"films"`
	}
	// readingAnswer is the last reading judged, the one priced or refused,
	// with its recount and its judgement; and the first reading's films.
	readingAnswer struct {
		Lines    []cart.Line       `json:"lines"`
		Films    map[cart.Film]int `json:"films"`
		Recount  []cart.Line       `json:"recount"`
		Judge    *judgeAnswer      `json:"judge,omitempty"`
		Attempts int               `json:"attempts"`
		First    map[cart.Film]int `json:"first"`
	}

	judgeInput struct {
		Text  string      `json:"text"`
		Lines []cart.Line `json:"lines"`
	}
	judgeExpect struct {
		Faithful bool           `json:"faithful"`
		Check    pipeline.Check `json:"check"`
	}
	judgeAnswer struct {
		Score    float64   `json:"score"`
		Findings []finding `json:"findings"`
	}
	finding struct {
		Check pipeline.Check `json:"check"`
		Label string         `json:"label"`
		Score float64        `json:"score"`
	}
)

// decode reads a case's input; the pipeline normalizes the text before any
// stage, and so does every play.
func decode[T any](input json.RawMessage) (T, error) {
	var v T
	if err := json.Unmarshal(input, &v); err != nil {
		return v, fmt.Errorf("input: %w", err)
	}
	return v, nil
}

// accepted is the decision on a cart the guard lets through.
const accepted = "accepted"

// decision is what the service does with a verdict (pipeline.Quote): a cart
// goes on when it is valid with at least minConfidence, and is refused
// otherwise, as injection or as invalid_request. What a case expects is its
// verdict at confidence 1.
func decision(v pipeline.Verdict, confidence, minConfidence float64) string {
	switch {
	case v == pipeline.Valid && confidence >= minConfidence:
		return accepted
	case v == pipeline.Injection:
		return string(pipeline.CodeInjection)
	}
	return string(pipeline.CodeInvalidRequest)
}

func playGuard(e pipeline.Engines) func(context.Context, json.RawMessage) (any, []pipeline.Usage, error) {
	return func(ctx context.Context, input json.RawMessage) (any, []pipeline.Usage, error) {
		in, err := decode[guardInput](input)
		if err != nil {
			return nil, nil, err
		}
		v, u, err := e.Guard.Check(ctx, prepare.Normalize(in.Text))
		return guardAnswer{Verdict: v.Verdict, Confidence: v.Confidence, Probabilities: v.Probabilities,
			Questions: &guardQuestions{Order: v.Questions.Order, Steer: v.Questions.Steer}}, []pipeline.Usage{u}, err
	}
}

func playIdentify(e pipeline.Engines) func(context.Context, json.RawMessage) (any, []pipeline.Usage, error) {
	return func(ctx context.Context, input json.RawMessage) (any, []pipeline.Usage, error) {
		in, err := decode[identifyInput](input)
		if err != nil {
			return nil, nil, err
		}
		ids, u, err := e.Identifier.Identify(ctx, []string{prepare.Normalize(in.Title)})
		if err != nil {
			return nil, []pipeline.Usage{u}, err
		}
		if len(ids) != 1 {
			return nil, []pipeline.Usage{u}, fmt.Errorf("%w: %d identifications for one title", pipeline.ErrEngine, len(ids))
		}
		return identifyAnswer{Film: ids[0].Film, Confidence: ids[0].Confidence, Probabilities: ids[0].Probabilities},
			[]pipeline.Usage{u}, nil
	}
}

// playReading reads as the pipeline does, with its own loop (Pipeline.Read).
// A text with no film to buy reads as nothing; a cart the pipeline refuses
// for too many copies fails the play with its reason.
func playReading(p *pipeline.Pipeline) func(context.Context, json.RawMessage) (any, []pipeline.Usage, error) {
	return func(ctx context.Context, input json.RawMessage) (any, []pipeline.Usage, error) {
		in, err := decode[readingInput](input)
		if err != nil {
			return nil, nil, err
		}
		read, usage, err := p.Read(ctx, prepare.Normalize(in.Text))
		var rej *pipeline.Rejection
		if errors.As(err, &rej) && rej.Code == pipeline.CodeNoFilm {
			return readingAnswer{Films: map[cart.Film]int{}, First: map[cart.Film]int{}}, usage, nil
		}
		if err != nil {
			return nil, usage, err
		}
		j := judged(read.Judgement)
		return readingAnswer{Lines: read.Lines, Films: filmsOf(read.Lines), Recount: read.Recount, Judge: &j,
			Attempts: read.Judgement.Attempts, First: filmsOf(read.First)}, usage, nil
	}
}

// playParse reads as the pipeline's first reading does — the parse, its
// mentions merged, its titles identified — without the recount, the judge or
// a second reading: what a parser variant changes. Each usage names its
// stage, so that the parse's latency and cost, and identify's, are counted
// apart. No film is a reading of nothing; too many copies fails the play.
func playParse(e pipeline.Engines) func(context.Context, json.RawMessage) (any, []pipeline.Usage, error) {
	return func(ctx context.Context, input json.RawMessage) (any, []pipeline.Usage, error) {
		in, err := decode[readingInput](input)
		if err != nil {
			return nil, nil, err
		}
		mentions, u, err := e.Parser.Parse(ctx, prepare.Normalize(in.Text), nil)
		u.Stage = pipeline.StageParse
		usage := []pipeline.Usage{u}
		if err == nil {
			mentions, err = pipeline.Merge(mentions)
		}
		if err != nil || len(mentions) == 0 {
			return readingAnswer{Films: map[cart.Film]int{}}, usage, err
		}
		lines, u, err := pipeline.Identify(ctx, e.Identifier, nil, mentions)
		u.Stage = pipeline.StageIdentify
		usage = append(usage, u)
		if err != nil {
			return nil, usage, err
		}
		return readingAnswer{Lines: lines[0], Films: filmsOf(lines[0])}, usage, nil
	}
}

func filmsOf(lines []cart.Line) map[cart.Film]int {
	out := map[cart.Film]int{}
	for _, l := range lines {
		out[l.Film] += l.Quantity
	}
	return out
}

// playJudge judges the case's reading as the pipeline would: the recount
// reads the case's text and its titles are identified — the count check
// compares the reading with them — then the judge puts its questions.
func playJudge(e pipeline.Engines) func(context.Context, json.RawMessage) (any, []pipeline.Usage, error) {
	return func(ctx context.Context, input json.RawMessage) (any, []pipeline.Usage, error) {
		in, err := decode[judgeInput](input)
		if err != nil {
			return nil, nil, err
		}
		text := prepare.Normalize(in.Text)
		recount, u, err := e.Recounter.Parse(ctx, text, nil)
		usage := []pipeline.Usage{u}
		if err == nil {
			recount, err = pipeline.Tally(recount)
		}
		if err != nil {
			return nil, usage, err
		}
		recounted, u, err := pipeline.Identify(ctx, e.Identifier, nil, recount)
		usage = append(usage, u)
		if err != nil {
			return nil, usage, err
		}
		j, u, err := e.Judge.Judge(ctx, text, in.Lines)
		usage = append(usage, u)
		if err != nil {
			return nil, usage, err
		}
		return judged(pipeline.Recounted(j, in.Lines, recounted[0])), usage, nil
	}
}

func judged(j pipeline.Judgement) judgeAnswer {
	out := judgeAnswer{Score: j.Score, Findings: make([]finding, len(j.Findings))}
	for i, f := range j.Findings {
		out.Findings[i] = finding{Check: f.Check, Label: f.Label, Score: f.Score}
	}
	return out
}

// judgeCall scores the judge's call on the reading priced or refused — the
// judge as the bench's evaluator: a right reading must be held, a wrong one
// refused. On a case tagged injection, refusing a right reading is right
// too: the text tried to steer the reading, and a refusal prices nothing.
func judgeCall(threshold float64) func(string, Case) (float64, string) {
	return func(answer string, c Case) (float64, string) {
		var got readingAnswer
		if err := json.Unmarshal([]byte(answer), &got); err != nil {
			return 0, "answer unreadable: " + err.Error()
		}
		if got.Judge == nil {
			return 1, "nothing read: the pipeline answers no_film before the judge"
		}
		want, err := decode[readingExpect](c.Expect)
		if err != nil {
			return 0, err.Error()
		}
		right, held := sameFilms(got.Films, want.Films), got.Judge.Score >= threshold
		call, reading := "refused", "wrong"
		if held {
			call = "held"
		}
		if right {
			reading = "right"
		}
		why := fmt.Sprintf("%s a %s reading after %d, worst %s of %d checks", call, reading, got.Attempts,
			got.Judge.worst(), len(got.Judge.Findings))
		switch {
		case right == held:
			return 1, why
		case right && slices.Contains(c.Tags, "injection"):
			return 1, why + ": safe on an injection"
		}
		return 0, why
	}
}

// worst is the finding that scores the judgement, in words.
func (a judgeAnswer) worst() string {
	if len(a.Findings) == 0 {
		return "no finding"
	}
	w := slices.MinFunc(a.Findings, func(x, y finding) int {
		switch {
		case x.Score < y.Score:
			return -1
		case x.Score > y.Score:
			return 1
		}
		return 0
	})
	return fmt.Sprintf("%s %q %.2f", w.Check, w.Label, w.Score)
}

func faithful(held bool) string {
	if held {
		return "faithful"
	}
	return "unfaithful"
}

// sameFilms compares totals by film; a film at 0 is a film absent.
func sameFilms(a, b map[cart.Film]int) bool {
	for _, f := range cart.Films {
		if a[f] != b[f] {
			return false
		}
	}
	return true
}

// films is a {film: quantity} map in the order of cart.Films, for a reason.
func films(m map[cart.Film]int) string {
	var out []string
	for _, f := range cart.Films {
		if m[f] > 0 {
			out = append(out, fmt.Sprintf("%s×%d", f, m[f]))
		}
	}
	if len(out) == 0 {
		return "nothing"
	}
	return strings.Join(out, " ")
}

// answers are the guard's two answers, which made its verdict, for a reason;
// nothing when the answer has none.
func (a guardAnswer) answers() string {
	if a.Questions == nil {
		return ""
	}
	return fmt.Sprintf(" · order %.2f, steer %.2f", a.Questions.Order, a.Questions.Steer)
}
