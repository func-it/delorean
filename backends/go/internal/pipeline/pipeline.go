package pipeline

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/prepare"
	"github.com/bn-k/delorean/backends/go/internal/pricing"
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
}

// Request is a cart to quote, and who asks, for the trace.
type Request struct {
	Cart      string
	UserID    string
	SessionID string
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
	ctx, span := startTrace(ctx, r.id, req)
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
	endTrace(span, q, err)
	return q, err
}

// newQuoteID is "q_" and 16 random base32 characters, 80 bits.
func newQuoteID() string {
	return "q_" + strings.ToLower(rand.Text()[:16])
}

// run is one reading under way.
type run struct {
	id     string
	report Report
}

// stage opens the span of s. end accounts for the stage's usage, traces its
// output or its error, and closes the span.
func (r *run) stage(ctx context.Context, s Stage) (_ context.Context, end func(u Usage, out any, err error)) {
	ctx, span := startStage(ctx, s)
	start := time.Now()
	return ctx, func(u Usage, out any, err error) {
		u.Stage = s
		if u.Ms == 0 { // engines that time their own calls keep their measure
			u.Ms = time.Since(start).Milliseconds()
		}
		r.report.Stages = append(r.report.Stages, u)
		r.report.CostUSD += u.CostUSD
		endStage(span, out, err)
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
	_, end := r.stage(ctx, StagePrepare)
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

	sctx, end := r.stage(ctx, StageGuard)
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

	sctx, end = r.stage(ctx, StageParse)
	mentions, u, err := p.Engines.Parser.Parse(sctx, text)
	if err == nil {
		mentions, err = Merge(mentions)
	}
	end(u, mentions, err)
	var rej *Rejection
	switch {
	case errors.As(err, &rej):
		return Quote{}, rej
	case err != nil:
		return Quote{}, failed(ctx, StageParse, err)
	case len(mentions) == 0:
		return Quote{}, &Rejection{Code: CodeNoFilm, Detail: "The text names no film to buy."}
	}

	titles := make([]string, len(mentions))
	for i, m := range mentions {
		titles[i] = m.Title
	}
	sctx, end = r.stage(ctx, StageIdentify)
	ids, u, err := p.Engines.Identifier.Identify(sctx, titles)
	var lines []cart.Line
	if err == nil {
		lines, err = Identified(mentions, ids)
	}
	end(u, lines, err)
	if err != nil {
		return Quote{}, failed(ctx, StageIdentify, err)
	}

	sctx, end = r.stage(ctx, StageJudge)
	judgement, u, err := p.Engines.Judge.Judge(sctx, text, lines)
	if err == nil {
		err = judgement.check()
	}
	end(u, judgement, err)
	if err != nil {
		return Quote{}, failed(ctx, StageJudge, err)
	}
	if judgement.Score < p.JudgeThreshold {
		return Quote{}, &Rejection{
			Code: CodeUnfaithfulReading,
			Detail: fmt.Sprintf("The judge does not hold the reading faithful to the text: its worst score, %.2f, is under %.2f.",
				judgement.Score, p.JudgeThreshold),
			Judgement: &judgement,
		}
	}

	_, end = r.stage(ctx, StagePrice)
	price := p.Catalog.Price(lines)
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

// Merge is how the pipeline takes a parser's reading: it adds up the
// mentions of one title, whatever its case and spacing, under its first
// spelling and in the order of the text. A mention without title, or with a
// quantity under 1, is out of the parser's contract, an ErrEngine: dropping
// it would price a cart the customer did not write. A title asked in more
// than cart.MaxQuantity copies is a *Rejection, quantity_too_large.
func Merge(mentions []cart.Mention) ([]cart.Mention, error) {
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
		key := strings.ToLower(strings.Join(strings.Fields(title), " "))
		i, ok := at[key]
		if !ok {
			i = len(merged)
			at[key] = i
			merged = append(merged, cart.Mention{Title: title})
		}
		// saturating: a sum that large is refused below, and must not wrap
		merged[i].Quantity += min(m.Quantity, math.MaxInt-merged[i].Quantity)
	}
	for _, m := range merged {
		if m.Quantity > cart.MaxQuantity {
			return nil, &Rejection{
				Code:   CodeQuantityTooLarge,
				Detail: fmt.Sprintf("%q is asked in %d copies; a cart holds at most %d of a title.", m.Title, m.Quantity, cart.MaxQuantity),
				Copies: &Copies{Title: m.Title, Count: m.Quantity, Max: cart.MaxQuantity},
			}
		}
	}
	return merged, nil
}

// Identified joins each mention to its identification, which an Identifier
// answers in the order of the titles. A missing identification, or one with a
// film or a confidence out of the contract, is an ErrEngine.
func Identified(mentions []cart.Mention, ids []Identification) ([]cart.Line, error) {
	if len(ids) != len(mentions) {
		return nil, fmt.Errorf("%w: %d identifications for %d titles", ErrEngine, len(ids), len(mentions))
	}
	lines := make([]cart.Line, len(mentions))
	for i, m := range mentions {
		id := ids[i]
		if !id.Film.Valid() || !unit(id.Confidence) {
			return nil, fmt.Errorf("%w: %q identified as %q with confidence %v", ErrEngine, m.Title, id.Film, id.Confidence)
		}
		lines[i] = cart.Line{Title: m.Title, Quantity: m.Quantity, Film: id.Film, Confidence: id.Confidence}
	}
	return lines, nil
}

func (v GuardVerdict) check() error {
	switch {
	case v.Verdict != Valid && v.Verdict != Injection && v.Verdict != Invalid:
		return fmt.Errorf("%w: guard verdict %q", ErrEngine, v.Verdict)
	case !unit(v.Confidence):
		return fmt.Errorf("%w: guard confidence %v", ErrEngine, v.Confidence)
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
