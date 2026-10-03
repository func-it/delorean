package pipeline

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/func-it/delorean/quoters/go/internal/cart"
)

// Reading is what reading a cart came to: the last reading judged, the
// recount it was compared with, and their judgement — Attempts set — and the
// first reading, to measure what reading again recovers.
type Reading struct {
	Lines     []cart.Line
	Recount   []cart.Line
	Judgement Judgement
	First     []cart.Line
}

// Read reads a normalized text as Quote does once the guard let it through:
// the parse beside the recount, identify, judge, and again while the judge
// refuses, up to ReadAttempts readings. It returns what each stage took. A
// reading the judge still refuses after the last attempt is no error: its
// judgement says so. The benches play it.
func (p *Pipeline) Read(ctx context.Context, text string) (Reading, []Usage, error) {
	r := &run{}
	read, err := p.readAgain(ctx, r, text)
	return read, r.report.Stages, err
}

// readAgain reads text up to ReadAttempts times (docs/architecture.md, 5′),
// until the judge holds a reading. Each new attempt parses again told what
// failed, recounts blind, identifies only the titles not seen yet, and puts
// to Jev only a reading it has not judged: a wrong reading Jev refuses two
// times in three would pass if judged three times.
func (p *Pipeline) readAgain(ctx context.Context, r *run, text string) (Reading, error) {
	var (
		out    Reading
		again  *Retry
		known  = map[string]Identification{}
		judged = map[string]Judgement{}
	)
	attempts := max(p.ReadAttempts, 1)
	for n := 1; n <= attempts; n++ {
		r.attempts = n
		raw, reading, recount, err := p.readTwice(ctx, r, text, n, again)
		if err != nil {
			return Reading{}, err
		}
		// a later reading with no film fails: it is not put to Jev
		j := Judgement{Findings: []Finding{{Check: CheckMissing, Label: WholeReading}}}
		var lines, recounted []cart.Line
		if len(reading) > 0 {
			sctx, end := r.stage(ctx, StageIdentify, n)
			both, u, err := Identify(sctx, p.Engines.Identifier, known, reading, recount)
			if err == nil {
				lines, recounted = both[0], both[1]
			}
			end(u, map[string][]cart.Line{"reading": lines, "recount": recounted}, err)
			if err != nil {
				return Reading{}, failed(ctx, StageIdentify, err)
			}
			if j, err = p.judge(ctx, r, n, text, judged, lines, recounted); err != nil {
				return Reading{}, err
			}
		}
		if n == 1 {
			out.First = lines
		}
		out.Lines, out.Recount, out.Judgement = lines, recounted, j
		if j.Score >= p.JudgeThreshold {
			out.Judgement.Attempts = n
			return out, nil
		}
		again = &Retry{Reading: raw, Findings: failing(j, p.JudgeThreshold)}
	}
	out.Judgement.Attempts = attempts
	return out, nil
}

// judge judges the lines of attempt n against the recount: Jev only when it
// has not judged the same lines yet — their findings are kept in judged, and
// put in the order of the lines now — then the count, anew.
func (p *Pipeline) judge(ctx context.Context, r *run, n int, text string, judged map[string]Judgement, lines, recounted []cart.Line) (Judgement, error) {
	sctx, end := r.stage(ctx, StageJudge, n)
	key := readingKey(lines)
	j, seen := judged[key]
	var u Usage
	var err error
	if seen {
		j = inLineOrder(j, lines)
	} else {
		j, u, err = p.Engines.Judge.Judge(sctx, text, lines)
		if err == nil {
			err = j.check()
		}
		if err == nil {
			judged[key] = j
		}
	}
	if err == nil {
		j = Recounted(j, lines, recounted)
		j.Attempts = n
	}
	end(u, j, err)
	if err != nil {
		return Judgement{}, failed(ctx, StageJudge, err)
	}
	return j, nil
}

// readTwice reads text with the parser — told what failed, again not nil —
// and the recounter, blind, side by side, and accounts for both, the parse
// first. It returns the parse's reading as read and merged, and the recount
// merged. On every attempt a parse that fails decides first, and cancels the
// recount; then a reading refused — too many copies, or no film on the first
// attempt — then a recount that fails. A later reading with no film is no
// refusal: it comes back empty.
func (p *Pipeline) readTwice(ctx context.Context, r *run, text string, attempt int, again *Retry) (raw, reading, recount []cart.Mention, err error) {
	type read struct {
		raw, mentions []cart.Mention
		usage         Usage
		err           error
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var parsed, recounted read
	var wg sync.WaitGroup
	wg.Go(func() {
		sctx, done := timed(ctx, StageParse, attempt)
		raw, u, err := p.Engines.Parser.Parse(sctx, text, again)
		var m []cart.Mention
		if err == nil {
			m, err = Tally(raw)
		}
		if err != nil {
			cancel()
		}
		// the span shows the reading; a refusal of it is the quote's
		u = done(u, m, err)
		if err == nil {
			err = Limit(m)
		}
		parsed = read{raw, m, u, err}
	})
	wg.Go(func() {
		sctx, done := timed(rctx, StageRecount, attempt)
		m, u, err := p.Engines.Recounter.Parse(sctx, text, nil)
		if err == nil {
			m, err = Tally(m)
		}
		recounted = read{nil, m, done(u, m, err), err}
	})
	wg.Wait()
	r.account(parsed.usage, recounted.usage)

	var rej *Rejection
	switch {
	case parsed.err != nil && !errors.As(parsed.err, &rej):
		return nil, nil, nil, failed(ctx, StageParse, parsed.err)
	case rej != nil:
		return nil, nil, nil, rej
	case len(parsed.mentions) == 0 && attempt == 1:
		return nil, nil, nil, &Rejection{Code: CodeNoFilm, Detail: "The text names no film to buy."}
	case recounted.err != nil:
		return nil, nil, nil, failed(ctx, StageRecount, recounted.err)
	}
	return parsed.raw, parsed.mentions, recounted.mentions, nil
}

// readingKey is the same for two readings of the same lines — title,
// quantity and film — in any order.
func readingKey(lines []cart.Line) string {
	keys := make([]string, len(lines))
	for i, l := range lines {
		keys[i] = fmt.Sprintf("%q %d %s", l.Title, l.Quantity, l.Film)
	}
	slices.Sort(keys)
	return strings.Join(keys, "\n")
}

// inLineOrder puts the findings of a reading judged before in the order of
// its lines now — the findings about a line are labelled with its title,
// unique in a merged reading — then those about the whole reading. The
// judgement given is left as it was.
func inLineOrder(j Judgement, lines []cart.Line) Judgement {
	titles := map[string]bool{}
	for _, l := range lines {
		titles[l.Title] = true
	}
	byLine := map[string][]Finding{}
	var whole []Finding
	for _, f := range j.Findings {
		if f.Check != CheckMissing && titles[f.Label] {
			byLine[f.Label] = append(byLine[f.Label], f)
		} else {
			whole = append(whole, f)
		}
	}
	findings := make([]Finding, 0, len(j.Findings))
	for _, l := range lines {
		findings = append(findings, byLine[l.Title]...)
	}
	j.Findings = append(findings, whole...)
	return j
}

// failing are the findings of j under threshold, in its order: what the
// parse is told when it reads again.
func failing(j Judgement, threshold float64) []Finding {
	var out []Finding
	for _, f := range j.Findings {
		if f.Score < threshold {
			out = append(out, f)
		}
	}
	return out
}
