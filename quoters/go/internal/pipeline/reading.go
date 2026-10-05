package pipeline

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

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
	// Counted: the last reading was counted against a recount. False when
	// the recount was left out at every reading (degraded).
	Counted bool
}

// Read reads a normalized text as Quote does once the guard let it through:
// the parse beside the recount (asked until one succeeded), identify, judge,
// and again while the judge refuses, up to ReadAttempts readings. It returns what each stage took. A
// reading the judge still refuses after the last attempt is no error: its
// judgement says so. The benches play it.
func (p *Pipeline) Read(ctx context.Context, text string) (Reading, []Usage, error) {
	r := &run{}
	read, err := p.readAgain(ctx, r, text)
	return read, r.report.Stages, err
}

// readAgain reads text up to ReadAttempts times (docs/architecture.md, 5′),
// until the judge holds a reading. Each new attempt parses again told what
// failed, identifies only the titles not seen yet, and puts to Jev only a
// reading it has not judged: a wrong reading Jev refuses two times in three
// would pass if judged three times. The recount reads blind — its input never
// changes between readings — so the first one that succeeded is kept for the
// whole request: later readings are counted against it, and it is not asked
// again. A reading whose recount failed is followed by one that asks it anew.
func (p *Pipeline) readAgain(ctx context.Context, r *run, text string) (Reading, error) {
	var (
		out    Reading
		again  *Retry
		known  = map[string]Identification{}
		judged = map[string]Judgement{}
		// the first recount that succeeded, for every reading after it
		kept   []cart.Mention
		isKept bool
	)
	attempts := max(p.ReadAttempts, 1)
	for n := 1; n <= attempts; n++ {
		r.attempts = n
		raw, reading, recount, counted, err := p.readTwice(ctx, r, text, n, again, kept, isKept)
		if err != nil {
			return Reading{}, err
		}
		if counted && !isKept {
			kept, isKept = recount, true
		}
		// a later reading with no film fails: it is not put to Jev
		j := Judgement{Findings: []Finding{{Check: CheckMissing, Label: WholeReading}}}
		var lines, recounted []cart.Line
		if len(reading) > 0 {
			sctx, end := r.stage(ctx, StageIdentify, n)
			readings := [][]cart.Mention{reading}
			if counted {
				readings = append(readings, recount)
			}
			both, u, err := Identify(sctx, p.Engines.Identifier, known, readings...)
			if err == nil {
				lines = both[0]
				if counted {
					recounted = both[1]
				}
			}
			end(u, map[string][]cart.Line{"reading": lines, "recount": recounted}, err)
			if err != nil {
				return Reading{}, failed(ctx, StageIdentify, err)
			}
			if j, err = p.judge(ctx, r, n, text, judged, lines, recounted, counted); err != nil {
				return Reading{}, err
			}
		}
		if n == 1 {
			out.First = lines
		}
		out.Lines, out.Recount, out.Judgement, out.Counted = lines, recounted, j, counted
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
// put in the order of the lines now — then the count, anew, when there is a
// recount (counted).
func (p *Pipeline) judge(ctx context.Context, r *run, n int, text string, judged map[string]Judgement, lines, recounted []cart.Line, counted bool) (Judgement, error) {
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
		// without a recount (degraded) there is nothing to count against
		if counted {
			j = Recounted(j, lines, recounted)
		}
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
// first. Once a recount succeeded (isKept, with its reading in kept) it is
// not asked again: only the parse runs, and kept comes back as the recount. It
// returns the parse's reading as read and merged, and the recount merged;
// counted is false when there is no recount. On every attempt a parse
// that fails decides first, and cancels the recount; then a reading refused —
// too many copies, or no film on the first attempt. A later reading with no
// film is no refusal: it comes back empty.
//
// The recount is a second opinion: one that fails, answers off its schema or
// is too slow (recount) does not fail the quote. The reading goes on without
// it — no recount, no count check, the stage's usage Degraded — and the judge
// stays the guard. Only a request that is over fails on the recount — and a
// failure that is no engine's (a bug) is not swallowed: it fails the quote as
// it would from any stage.
func (p *Pipeline) readTwice(ctx context.Context, r *run, text string, attempt int, again *Retry, kept []cart.Mention, isKept bool) (raw, reading, recount []cart.Mention, counted bool, err error) {
	type read struct {
		raw, mentions []cart.Mention
		usage         Usage
		err           error
	}
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var parsed, recounted read
	// the recount's span is closed once both readings settled: whether it is
	// degraded depends on the parse beside it
	var endRecount func(u Usage, out any, err error) Usage
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
	if !isKept {
		wg.Go(func() {
			sctx, done := timed(rctx, StageRecount, attempt)
			start := time.Now()
			m, u, err := p.recount(sctx, text)
			if u.Ms == 0 { // its own time, not the parse's it then waits for
				u.Ms = time.Since(start).Milliseconds()
			}
			endRecount, recounted = done, read{nil, m, u, err}
		})
	}
	wg.Wait()
	var rej *Rejection
	parseFailed := parsed.err != nil && !errors.As(parsed.err, &rej)
	if isKept {
		// no recount call, span or usage: the kept one stands for this reading too
		r.account(parsed.usage)
	} else {
		// an engine's failure of the recount itself, not of the request nor of a parse that failed beside it
		recounted.usage.Degraded = recounted.err != nil && errors.Is(recounted.err, ErrEngine) && !parseFailed && ctx.Err() == nil
		recounted.usage = endRecount(recounted.usage, recounted.mentions, recounted.err)
		r.account(parsed.usage, recounted.usage)
	}

	switch {
	case parseFailed:
		return nil, nil, nil, false, failed(ctx, StageParse, parsed.err)
	case rej != nil:
		return nil, nil, nil, false, rej
	case len(parsed.mentions) == 0 && attempt == 1:
		return nil, nil, nil, false, &Rejection{Code: CodeNoFilm, Detail: "The text names no film to buy."}
	case isKept:
		return parsed.raw, parsed.mentions, kept, true, nil
	case recounted.err != nil && ctx.Err() != nil:
		return nil, nil, nil, false, failed(ctx, StageRecount, recounted.err)
	case recounted.err != nil && !errors.Is(recounted.err, ErrEngine):
		return nil, nil, nil, false, fmt.Errorf("%s: %w", StageRecount, recounted.err)
	}
	return parsed.raw, parsed.mentions, recounted.mentions, recounted.err == nil, nil
}

// recount asks the recounter for its reading, tallied, within RecountTimeout:
// a second time, when the first call failed in under half of it — an answer
// off its schema comes quickly, a slow model does not get faster — with what
// is left. The usage adds up the calls. Not a word to the recounter about
// what failed: it reads blind.
func (p *Pipeline) recount(ctx context.Context, text string) ([]cart.Mention, Usage, error) {
	parent := ctx
	// the recount's own time running out is an engine that did not answer in time
	timedOut := func(err error) error {
		if err != nil && !errors.Is(err, ErrEngine) && errors.Is(err, context.DeadlineExceeded) && parent.Err() == nil {
			return fmt.Errorf("%w: %w", ErrEngine, err)
		}
		return err
	}
	if p.RecountTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, p.RecountTimeout)
		defer cancel()
	}
	start := time.Now()
	m, u, err := p.recountOnce(ctx, text)
	if err == nil || p.RecountTimeout <= 0 || ctx.Err() != nil || time.Since(start) >= p.RecountTimeout/2 {
		return m, u, timedOut(err)
	}
	m, again, err := p.recountOnce(ctx, text)
	u.Calls += again.Calls
	u.CostUSD += again.CostUSD
	u.Ms += again.Ms
	u.Engine, u.Model = cmp.Or(u.Engine, again.Engine), cmp.Or(u.Model, again.Model)
	return m, u, timedOut(err)
}

func (p *Pipeline) recountOnce(ctx context.Context, text string) ([]cart.Mention, Usage, error) {
	m, u, err := p.Engines.Recounter.Parse(ctx, text, nil)
	if err == nil {
		m, err = Tally(m)
	}
	return m, u, err
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
