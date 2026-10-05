package live

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/jsonx"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Judge holds a reading against the text it was read from, before any price.
// It is the judge of the benches (a probe) put in production, and keeps
// what it learnt of Jev: a short question on one observable fact — asked
// "is it consistent?", Jev answers with blurred probabilities; one item per
// request — Jev is reliable on one fact, blurred on a list; the worst score
// decides.
//
//	asked     each line      does the customer ask to buy this film?          p
//	identity  each line      is this title the film it was identified as?     p
//	missing   whole reading  does the customer ask for a film not listed?     1 − p
//
// Jev does not count: the copies are the recount's to check, in code
// (pipeline.Recounted).
type Judge struct{ Jev decide.Decider }

// probe is one question of the judge, put about one item of the reading.
type probe struct {
	check    pipeline.Check
	label    string
	question decide.Question
	state    map[string]any
	// invert scores 1 − p: the question hunts a fault, and "yes" is bad.
	invert bool
}

// probes are every question the judge puts about a reading: asked and
// identity for each line, then missing for the whole of it. What Jev reads is
// docs/architecture.md's, word for word, so that every implementation asks
// the same thing.
func probes(text string, lines []cart.Line) []probe {
	q := prompts.judge
	out := make([]probe, 0, 2*len(lines)+1)
	listed := make([]string, len(lines))
	for i, l := range lines {
		title := quoted(l.Title)
		listed[i] = fmt.Sprintf("- %d × %s", l.Quantity, title)
		out = append(out,
			probe{check: pipeline.CheckAsked, label: l.Title, question: q.Asked, state: map[string]any{
				customerMessage: text, "order_line": title}},
			probe{check: pipeline.CheckIdentity, label: l.Title, question: q.Identity, state: map[string]any{
				customerMessage: text, "order_line": title + ", identified as " + q.Films[l.Film]}},
		)
	}
	return append(out, probe{check: pipeline.CheckMissing, label: pipeline.WholeReading, question: q.Missing,
		state: map[string]any{customerMessage: text, "order_lines": strings.Join(listed, "\n")}, invert: true})
}

// quoted is s as a JSON string, for what Jev reads (jsonx.Quote).
func quoted(s string) string { return jsonx.Quote(s) }

func (j Judge) Judge(ctx context.Context, text string, lines []cart.Line) (pipeline.Judgement, pipeline.Usage, error) {
	start := time.Now()
	ps := probes(text, lines)
	reqs := make([]decide.Request, len(ps))
	for i, p := range ps {
		reqs[i] = decide.Request{State: p.state, Questions: []decide.Question{p.question}}
	}
	ds, sent, err := decide.DecideAll(ctx, j.Jev, reqs)
	if err != nil {
		return pipeline.Judgement{}, jevUsage(j.Jev, start, sent, ds), failed(pipeline.StageJudge, err)
	}
	out := pipeline.Judgement{Score: 1, Findings: make([]pipeline.Finding, len(ps))}
	for i, p := range ps {
		score := ds[i].Answers[p.question.Key].Noul
		if p.invert {
			score = 1 - score
		}
		out.Findings[i] = pipeline.Finding{Check: p.check, Label: p.label, Score: score}
		out.Score = min(out.Score, score)
	}
	return out, jevUsage(j.Jev, start, sent, ds), nil
}
