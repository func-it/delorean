package pipeline

import (
	"cmp"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/prepare"
	"github.com/func-it/delorean/quoters/go/internal/pricing"
)

// Pipeline reads carts into quotes: its engines, and the rules that decide.
// Set the fields before the first Quote and leave them be; a Pipeline is
// then safe for concurrent use.
type Pipeline struct {
	Engines Engines
	Counter *prepare.Counter
	Catalog pricing.Catalog
	// MaxInputTokens bounds a cart, counted once normalized.
	MaxInputTokens int
	// GuardMinConfidence is the least confidence of a valid verdict.
	GuardMinConfidence float64
	// JudgeThreshold is the least worst score of a reading that is priced.
	JudgeThreshold float64
	// ReadAttempts is the most readings of one cart, the first included,
	// before it is refused as unfaithful; below 1, one.
	ReadAttempts int
	// RecountTimeout is the time the recount has, a retry included: past it
	// the reading goes on without the recount (degraded). It is tried a
	// second time when the first failed in under half of it. 0 gives it the
	// request's whole budget and no retry.
	RecountTimeout time.Duration
	// Prompts are the versions of the prompts the engines read, by file
	// (guard, parse, identify, judge), for the trace.
	Prompts map[string]string
	// Measured, when set, is told what each traced quote took and came to:
	// the scores Langfuse keeps of it.
	Measured func(Measures)
}

// Request is a cart to quote, and who asks, for the trace.
type Request struct {
	Cart      string
	UserID    string
	SessionID string
	RequestID string
	// Answer, when set, is the body the API sends for the quote or the
	// error: the trace's output, as sent. Without it, the trace keeps a
	// summary.
	Answer func(Quote, error) string
}

// Measures are what one quote took and came to, as Langfuse scores its
// trace (docs/architecture.md, "Usage, cost and traces").
type Measures struct {
	TraceID string
	CostUSD float64
	Ms      int64
	// Attempts are the readings made; 0 when the cart was refused before
	// the parse.
	Attempts int
	// Outcome is "priced", or the problem's code.
	Outcome string
	// Degraded: a stage failed and the quote went on without it (the recount).
	Degraded bool
}

// Quote is a cart read, held faithful by the judge, and priced.
type Quote struct {
	ID        string
	Price     pricing.Quote
	Judgement Judgement
	Report    Report
	CreatedAt time.Time
}

// Report is what a reading took: each stage that ran, in order, and the
// totals. TraceID is set only when traces are exported.
type Report struct {
	Stages  []Usage
	Ms      int64
	CostUSD float64
	TraceID string
}

// engineLocal is the engine of the stages that are plain code.
const engineLocal = "local"

// Quote reads a cart and prices it. A cart a stage refuses is a *Rejection,
// which reports what the reading took up to there. An engine that fails, that
// answers out of contract, or that does not answer before ctx ends, is an
// error wrapping ErrEngine.
func (p *Pipeline) Quote(ctx context.Context, req Request) (Quote, error) {
	start := time.Now()
	r := &run{id: newQuoteID()}
	ctx, span := p.startTrace(ctx, req)
	defer span.End()

	q, err := p.read(ctx, r, req.Cart)
	report := r.report
	report.Ms = time.Since(start).Milliseconds()
	if sc := span.SpanContext(); sc.IsValid() {
		report.TraceID = sc.TraceID().String()
	}
	var rej *Rejection
	switch {
	case errors.As(err, &rej):
		rej.Report = report
	case err == nil:
		q.Report = report
	}
	m := Measures{TraceID: report.TraceID, CostUSD: report.CostUSD, Ms: report.Ms, Attempts: r.attempts, Outcome: outcome(err),
		Degraded: slices.ContainsFunc(report.Stages, func(u Usage) bool { return u.Degraded })}
	out := ""
	if req.Answer != nil {
		out = req.Answer(q, err)
	}
	endTrace(span, q, err, m, out)
	if p.Measured != nil && m.TraceID != "" {
		p.Measured(m)
	}
	return q, err
}

// outcome is how a quote ended: "priced", or the code of the problem the API
// answers — a refusal's, engine_unavailable, or internal.
func outcome(err error) string {
	var rej *Rejection
	switch {
	case err == nil:
		return "priced"
	case errors.As(err, &rej):
		return string(rej.Code)
	case errors.Is(err, ErrEngine):
		return "engine_unavailable"
	}
	return "internal"
}

// newQuoteID is "q_" and 16 random base32 characters, 80 bits.
func newQuoteID() string {
	return "q_" + strings.ToLower(rand.Text()[:16])
}

// run is one reading under way.
type run struct {
	id     string
	report Report
	// attempts are the readings started.
	attempts int
}

// stage opens the span of s, in reading attempt (0 outside the readings).
// end closes it, and accounts for the stage's usage in the report.
func (r *run) stage(ctx context.Context, s Stage, attempt int) (_ context.Context, end func(u Usage, out any, err error)) {
	ctx, done := timed(ctx, s, attempt)
	return ctx, func(u Usage, out any, err error) { r.account(done(u, out, err)) }
}

// account adds what stages took to the report: a stage's first usage in the
// order given, and those of later readings added up to it.
func (r *run) account(us ...Usage) {
	for _, u := range us {
		r.report.CostUSD += u.CostUSD
		i := slices.IndexFunc(r.report.Stages, func(s Usage) bool { return s.Stage == u.Stage })
		if i < 0 {
			r.report.Stages = append(r.report.Stages, u)
			continue
		}
		s := &r.report.Stages[i]
		s.Engine, s.Model = cmp.Or(s.Engine, u.Engine), cmp.Or(s.Model, u.Model)
		s.Calls += u.Calls
		s.Ms += u.Ms
		s.CostUSD += u.CostUSD
		s.Degraded = s.Degraded || u.Degraded
	}
}

// timed opens the span of s, in reading attempt. done stamps the stage's
// usage with its name and, unless the engine timed its own calls, its
// duration; traces its output or its error; closes the span; and returns the
// usage. It leaves the report alone: two stages may run side by side.
func timed(ctx context.Context, s Stage, attempt int) (_ context.Context, done func(u Usage, out any, err error) Usage) {
	ctx, span := startStage(ctx, s, attempt)
	start := time.Now()
	return ctx, func(u Usage, out any, err error) Usage {
		u.Stage = s
		if u.Ms == 0 {
			u.Ms = time.Since(start).Milliseconds()
		}
		endStage(span, out, err, u.Degraded)
		return u
	}
}

// failed wraps the error of stage s. An engine that did not answer before the
// request's deadline is unavailable, whatever it says.
func failed(ctx context.Context, s Stage, err error) error {
	if ctx.Err() != nil && !errors.Is(err, ErrEngine) {
		return fmt.Errorf("%s: %w: %w", s, ErrEngine, err)
	}
	return fmt.Errorf("%s: %w", s, err)
}

func (p *Pipeline) read(ctx context.Context, r *run, raw string) (Quote, error) {
	_, end := r.stage(ctx, StagePrepare, 0)
	text := prepare.Normalize(raw)
	tokens := p.Counter.Count(text)
	end(Usage{Engine: engineLocal, Tokens: tokens}, map[string]int{"tokens": tokens}, nil)
	if text == "" {
		return Quote{}, &Rejection{Code: CodeEmptyCart, Detail: "The cart is empty."}
	}
	if tokens > p.MaxInputTokens {
		return Quote{}, &Rejection{
			Code:   CodeTooLong,
			Detail: fmt.Sprintf("The cart counts %d tokens, the limit is %d.", tokens, p.MaxInputTokens),
			Tokens: &Tokens{Count: tokens, Max: p.MaxInputTokens},
		}
	}

	sctx, end := r.stage(ctx, StageGuard, 0)
	verdict, u, err := p.Engines.Guard.Check(sctx, text)
	if err == nil {
		err = verdict.check()
	}
	end(u, verdict, err)
	if err != nil {
		return Quote{}, failed(ctx, StageGuard, err)
	}
	if verdict.Verdict != Valid || verdict.Confidence < p.GuardMinConfidence {
		return Quote{}, p.guardRejection(verdict)
	}

	read, err := p.readAgain(ctx, r, text)
	if err != nil {
		return Quote{}, err
	}
	judgement := read.Judgement
	if judgement.Score < p.JudgeThreshold {
		return Quote{}, &Rejection{
			Code: CodeUnfaithfulReading,
			Detail: fmt.Sprintf("The judge does not hold the reading faithful to the text: its worst score, %.2f, is under %.2f.",
				judgement.Score, p.JudgeThreshold),
			Judgement: &judgement,
		}
	}

	_, end = r.stage(ctx, StagePrice, 0)
	price := p.Catalog.Price(read.Lines)
	end(Usage{Engine: engineLocal}, map[string]int{"total_cents": price.TotalCents}, nil)
	return Quote{ID: r.id, Price: price, Judgement: judgement, CreatedAt: time.Now().UTC()}, nil
}

func (p *Pipeline) guardRejection(v GuardVerdict) *Rejection {
	rej := &Rejection{Code: CodeInvalidRequest, Guard: &v}
	switch v.Verdict {
	case Injection:
		rej.Code = CodeInjection
		rej.Detail = "The text tries to instruct the system instead of ordering films."
	case Valid:
		rej.Detail = fmt.Sprintf("The guard is not confident enough that the text orders films: %.2f, under %.2f.",
			v.Confidence, p.GuardMinConfidence)
	default:
		rej.Detail = "The text does not order films: gibberish, a language not understood, or off topic."
	}
	return rej
}

// Tally adds up the mentions of one title, whatever its case and spacing,
// under its first spelling and in the order of the text. A mention without
// title, or with a quantity under 1, is out of the parser's contract, an
// ErrEngine: dropping it would price a cart the customer did not write.
func Tally(mentions []cart.Mention) ([]cart.Mention, error) {
	var merged []cart.Mention
	at := map[string]int{}
	for _, m := range mentions {
		title := strings.TrimSpace(m.Title)
		if title == "" {
			return nil, fmt.Errorf("%w: a mention has no title", ErrEngine)
		}
		if m.Quantity < 1 {
			return nil, fmt.Errorf("%w: %q: quantity %d is under 1", ErrEngine, title, m.Quantity)
		}
		if m.Film != "" && !m.Film.Valid() {
			return nil, fmt.Errorf("%w: %q: film %q", ErrEngine, title, m.Film)
		}
		key := TitleKey(title)
		i, ok := at[key]
		if !ok {
			i = len(merged)
			at[key] = i
			merged = append(merged, cart.Mention{Title: title, Film: m.Film})
		}
		merged[i].Quantity = add(merged[i].Quantity, m.Quantity)
		merged[i].Film = cmp.Or(merged[i].Film, m.Film)
	}
	return merged, nil
}

// Merge is how the pipeline takes the parser's reading: Tally, then the
// limit — a title asked in more than cart.MaxQuantity copies is a
// *Rejection, quantity_too_large. The recount is only tallied: it is
// compared, it never refuses.
func Merge(mentions []cart.Mention) ([]cart.Mention, error) {
	merged, err := Tally(mentions)
	if err != nil {
		return nil, err
	}
	if err := Limit(merged); err != nil {
		return nil, err
	}
	return merged, nil
}

// Limit refuses a tallied reading with a title asked in more than
// cart.MaxQuantity copies: a *Rejection, quantity_too_large.
func Limit(merged []cart.Mention) error {
	for _, m := range merged {
		if m.Quantity > cart.MaxQuantity {
			return &Rejection{
				Code:   CodeQuantityTooLarge,
				Detail: fmt.Sprintf("%q is asked in %d copies; a cart holds at most %d of a title.", m.Title, m.Quantity, cart.MaxQuantity),
				Copies: &Copies{Title: m.Title, Count: m.Quantity, Max: cart.MaxQuantity},
			}
		}
	}
	return nil
}

// TitleKey is what two spellings of one title share: its words, lowercased.
// Mentions of one title merge under it; a title is identified once under it.
func TitleKey(title string) string {
	return strings.ToLower(strings.Join(strings.Fields(title), " "))
}

// add is a + b, saturating: a sum that large is refused or compared, and
// must not wrap.
func add(a, b int) int { return a + min(b, math.MaxInt-a) }

// Identify gives the lines of each reading, in the order of the readings.
// The titles known has not seen — keyed as Tally merges them, and every
// distinct title of a reading and its recount, which share most — are
// identified in one call to id, then added to known: an identification is
// never asked twice. A title the parser identified (a mention with its film)
// is not asked: its line keeps that film, at confidence 1, and a recount's
// line of the same title takes it too; the judge's identity check holds it
// to the text. known may be nil. A missing identification, or one with a
// film or a confidence out of the contract, is an ErrEngine.
func Identify(ctx context.Context, id Identifier, known map[string]Identification, readings ...[]cart.Mention) ([][]cart.Line, Usage, error) {
	if known == nil {
		known = map[string]Identification{}
	}
	read := map[string]cart.Film{} // the films the readings give
	for _, mentions := range readings {
		for _, m := range mentions {
			if k := TitleKey(m.Title); m.Film != "" && read[k] == "" {
				read[k] = m.Film
			}
		}
	}
	var titles []string
	asked := map[string]bool{}
	for _, mentions := range readings {
		for _, m := range mentions {
			if k := TitleKey(m.Title); !asked[k] && read[k] == "" {
				if _, ok := known[k]; !ok {
					asked[k] = true
					titles = append(titles, m.Title)
				}
			}
		}
	}
	var u Usage
	if len(titles) > 0 {
		var ids []Identification
		var err error
		ids, u, err = id.Identify(ctx, titles)
		if err != nil {
			return nil, u, err
		}
		if len(ids) != len(titles) {
			return nil, u, fmt.Errorf("%w: %d identifications for %d titles", ErrEngine, len(ids), len(titles))
		}
		for i, got := range ids {
			if !got.Film.Valid() || !unit(got.Confidence) {
				return nil, u, fmt.Errorf("%w: %q identified as %q with confidence %v", ErrEngine, titles[i], got.Film, got.Confidence)
			}
		}
		for i, t := range titles {
			known[TitleKey(t)] = ids[i]
		}
	}
	out := make([][]cart.Line, len(readings))
	for r, mentions := range readings {
		out[r] = make([]cart.Line, len(mentions))
		for i, m := range mentions {
			got := known[TitleKey(m.Title)]
			if film := cmp.Or(m.Film, read[TitleKey(m.Title)]); film != "" {
				got = Identification{Film: film, Confidence: 1}
			}
			out[r][i] = cart.Line{Title: m.Title, Quantity: m.Quantity, Film: got.Film, Confidence: got.Confidence}
		}
	}
	return out, u, nil
}

// Recounted adds the count check to a judgement: for each film either
// reading has, in the order of cart.Films, 1 when the reading and the recount
// give it as many copies, 0 when not — every film outside the saga counted
// together, as the price counts them. The worst score still decides.
func Recounted(j Judgement, lines, recount []cart.Line) Judgement {
	read, recounted := copiesByFilm(lines), copiesByFilm(recount)
	j.Findings = slices.Clone(j.Findings)
	for _, f := range cart.Films {
		n, m := read[f], recounted[f]
		if n == 0 && m == 0 {
			continue
		}
		score := 0.0
		if n == m {
			score = 1
		}
		j.Findings = append(j.Findings, Finding{Check: CheckCount, Label: fmt.Sprintf("%s: %d read, %d recounted", f, n, m), Score: score})
		j.Score = min(j.Score, score)
	}
	return j
}

func copiesByFilm(lines []cart.Line) map[cart.Film]int {
	out := map[cart.Film]int{}
	for _, l := range lines {
		out[l.Film] = add(out[l.Film], l.Quantity)
	}
	return out
}

func (v GuardVerdict) check() error {
	switch {
	case v.Verdict != Valid && v.Verdict != Injection && v.Verdict != Invalid:
		return fmt.Errorf("%w: guard verdict %q", ErrEngine, v.Verdict)
	case !unit(v.Confidence):
		return fmt.Errorf("%w: guard confidence %v", ErrEngine, v.Confidence)
	case !unit(v.Questions.Order) || !unit(v.Questions.Steer):
		return fmt.Errorf("%w: guard answers %+v", ErrEngine, v.Questions)
	}
	return nil
}

func (j Judgement) check() error {
	if !unit(j.Score) {
		return fmt.Errorf("%w: judge score %v", ErrEngine, j.Score)
	}
	for _, f := range j.Findings {
		if !f.Check.Valid() || !unit(f.Score) {
			return fmt.Errorf("%w: judge check %q scored %v", ErrEngine, f.Check, f.Score)
		}
	}
	return nil
}

// unit reports whether x is a probability, 0 to 1. NaN is not.
func unit(x float64) bool { return x >= 0 && x <= 1 }
