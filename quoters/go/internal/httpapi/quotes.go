package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// The formats of the contract's headers, length included.
var (
	userIDFormat    = regexp.MustCompile(`^[A-Za-z0-9._@-]{1,64}$`)
	sessionIDFormat = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	requestIDFormat = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
)

// CreateQuote answers POST /v1/quotes.
func (s *server) CreateQuote(w http.ResponseWriter, r *http.Request, params CreateQuoteParams) {
	if err := checkHeaders(params); err != nil {
		writeProblem(w, r, newProblem(http.StatusBadRequest, ProblemCodeMalformedRequest, err.Error()), nil)
		return
	}
	text, err := readCart(w, r, s.MaxBodyBytes)
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		writeProblem(w, r, newProblem(http.StatusRequestEntityTooLarge, ProblemCodePayloadTooLarge,
			fmt.Sprintf("The body exceeds %d bytes.", tooLarge.Limit)), nil)
		return
	case err != nil:
		writeProblem(w, r, newProblem(http.StatusBadRequest, ProblemCodeMalformedRequest, err.Error()), nil)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.RequestTimeout)
	defer cancel()
	// the body is made before the trace ends, which keeps it as its output:
	// the trace shows what was sent
	var sent *response
	answer := func(q pipeline.Quote, err error) string {
		sent = s.answer(r, q, err)
		return string(sent.body)
	}
	q, err := s.Pipeline.Quote(ctx, pipeline.Request{Cart: text, UserID: value(params.XUserId),
		SessionID: value(params.XSessionId), RequestID: exchangeOf(r).id, Answer: answer})
	if sent == nil {
		answer(q, err)
	}
	sent.send(w, r)
}

// answer is the response to a quote, or to the error that ended it.
func (s *server) answer(r *http.Request, q pipeline.Quote, err error) *response {
	var rej *pipeline.Rejection
	switch {
	case errors.As(err, &rej):
		exchangeOf(r).degraded = degraded(rej.Report)
		return problemResponse(r, s.rejected(rej), nil)
	case errors.Is(err, pipeline.ErrEngine):
		return problemResponse(r, newProblem(http.StatusBadGateway, ProblemCodeEngineUnavailable,
			"A model engine could not be reached, or answered out of contract."), err)
	case err != nil:
		return problemResponse(r, internalProblem(), err)
	}
	exchangeOf(r).degraded = degraded(q.Report)
	return jsonResponse(http.StatusOK, "application/json", s.quote(q))
}

// degraded: a stage of the report failed and the answer was made without it.
func degraded(r pipeline.Report) bool {
	return slices.ContainsFunc(r.Stages, func(u pipeline.Usage) bool { return u.Degraded })
}

func checkHeaders(p CreateQuoteParams) error {
	for _, h := range []struct {
		name   string
		value  *string
		format *regexp.Regexp
	}{
		{"X-User-Id", p.XUserId, userIDFormat},
		{"X-Session-Id", p.XSessionId, sessionIDFormat},
		{"X-Request-Id", p.XRequestId, requestIDFormat},
	} {
		if h.value != nil && !h.format.MatchString(*h.value) {
			return fmt.Errorf("header %s: must match %s", h.name, h.format)
		}
	}
	return nil
}

// readCart decodes a QuoteRequest, strictly: one JSON object in UTF-8, with
// a cart string and no other field. encoding/json would repair an invalid
// byte into U+FFFD: the body is refused instead, as RFC 8259 has it. A body
// over limit is an *http.MaxBytesError. The checks run in the order of
// docs/architecture.md (Identical quoters), each with its own words.
func readCart(w http.ResponseWriter, r *http.Request, limit int64) (string, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return "", err
	}
	if !utf8.Valid(body) {
		return "", errors.New("body: not valid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	var whole json.RawMessage
	if err := dec.Decode(&whole); err != nil {
		return "", bodyError(err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return "", errors.New("body: unexpected data after the QuoteRequest object")
	}
	if kind := jsonKind(whole); kind != "object" {
		return "", fmt.Errorf("body: a QuoteRequest object is expected, not a JSON %s", kind)
	}
	fields := json.NewDecoder(bytes.NewReader(whole))
	fields.DisallowUnknownFields()
	var req struct {
		Cart json.RawMessage `json:"cart"`
	}
	if err := fields.Decode(&req); err != nil {
		// unknown fields have no error type of their own
		return "", fmt.Errorf("body: %s", strings.TrimPrefix(err.Error(), "json: "))
	}
	if req.Cart == nil {
		return "", errors.New(`body: field "cart" is required`)
	}
	var cart string
	if kind := jsonKind(req.Cart); kind != "string" || json.Unmarshal(req.Cart, &cart) != nil {
		return "", fmt.Errorf(`body: field "cart" must be a string, not a JSON %s`, kind)
	}
	return cart, nil
}

// bodyError says what is wrong with a body that is not one JSON value, in
// terms of the contract rather than of encoding/json: no parser's wording,
// which no two runtimes share.
func bodyError(err error) error {
	var (
		tooLarge *http.MaxBytesError
		syntax   *json.SyntaxError
	)
	switch {
	case errors.As(err, &tooLarge):
		return err
	case errors.Is(err, io.EOF):
		return errors.New("body: empty, a QuoteRequest object is expected")
	case errors.Is(err, io.ErrUnexpectedEOF):
		return errors.New("body: truncated JSON")
	case errors.As(err, &syntax):
		return errors.New("body: invalid JSON")
	}
	return fmt.Errorf("body: %w", err)
}

// jsonKind is the JSON type of a valid value, in JSON's words: null,
// boolean, number, string, array or object.
func jsonKind(v json.RawMessage) string {
	switch v[0] {
	case 'n':
		return "null"
	case 't', 'f':
		return "boolean"
	case '"':
		return "string"
	case '[':
		return "array"
	case '{':
		return "object"
	}
	return "number"
}

func value(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *server) quote(q pipeline.Quote) Quote {
	lines := make([]QuoteLine, len(q.Price.Lines))
	for i, l := range q.Price.Lines {
		lines[i] = QuoteLine{
			Title:          l.Title,
			Quantity:       l.Quantity,
			Film:           Film(l.Film),
			Confidence:     l.Confidence,
			UnitPriceCents: l.UnitCents,
			SubtotalCents:  l.SubtotalCents,
		}
	}
	d := q.Price.Discount
	return Quote{
		Id:            q.ID,
		Currency:      QuoteCurrencyEUR,
		Lines:         lines,
		SubtotalCents: q.Price.SubtotalCents,
		Discount: Discount{
			DistinctVolumes: d.DistinctVolumes,
			Percent:         DiscountPercent(d.Percent),
			BaseCents:       d.BaseCents,
			AmountCents:     d.AmountCents,
		},
		TotalCents: q.Price.TotalCents,
		Judge:      s.judge(q.Judgement),
		Usage:      s.usage(q.Report),
		CreatedAt:  Instant(q.CreatedAt),
	}
}

func (s *server) judge(j pipeline.Judgement) JudgeOutcome {
	checks := make([]JudgeCheck, len(j.Findings))
	for i, f := range j.Findings {
		checks[i] = JudgeCheck{Check: JudgeCheckCheck(f.Check), Label: f.Label, Score: f.Score}
	}
	return JudgeOutcome{Score: j.Score, Threshold: s.Pipeline.JudgeThreshold, Checks: checks, Attempts: j.Attempts}
}

func (s *server) usage(r pipeline.Report) Usage {
	stages := make([]StageUsage, len(r.Stages))
	for i, u := range r.Stages {
		stages[i] = StageUsage{
			Stage:      StageUsageStage(u.Stage),
			Engine:     u.Engine,
			Calls:      u.Calls,
			DurationMs: int(u.Ms),
			CostUsd:    u.CostUSD,
		}
		if u.Model != "" {
			stages[i].Model = new(u.Model)
		}
		if u.Degraded {
			stages[i].Degraded = new(true)
		}
		if u.Stage == pipeline.StagePrepare {
			stages[i].Tokens = new(u.Tokens)
		}
	}
	usage := Usage{
		Implementation: UsageImplementationGo,
		Engines:        UsageEngines(s.Pipeline.Engines.Name),
		DurationMs:     int(r.Ms),
		CostUsd:        r.CostUSD,
		Stages:         stages,
	}
	if r.TraceID != "" {
		usage.TraceId = new(r.TraceID)
	}
	return usage
}

func guardOutcome(v pipeline.GuardVerdict) GuardOutcome {
	g := GuardOutcome{Verdict: GuardOutcomeVerdict(v.Verdict), Confidence: v.Confidence,
		Questions: &GuardOutcome_Questions{Order: v.Questions.Order, Steer: v.Questions.Steer}}
	if len(v.Probabilities) > 0 {
		probabilities := make(map[string]float64, len(v.Probabilities))
		for verdict, p := range v.Probabilities {
			probabilities[string(verdict)] = p
		}
		g.Probabilities = &probabilities
	}
	return g
}
