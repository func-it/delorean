package pipeline

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"

	"github.com/func-it/delorean/quoters/go/internal/jsonx"
)

// The attributes Langfuse reads off OpenTelemetry spans
// (trpc-agent-go, telemetry/langfuse/attribute.go); user and session under
// the names the Langfuse SDKs give them, as the other quoters do.
const (
	attrTraceName         = "langfuse.trace.name"
	attrUserID            = "user.id"
	attrSessionID         = "session.id"
	attrTraceTags         = "langfuse.trace.tags"
	attrTraceInput        = "langfuse.trace.input"
	attrTraceOutput       = "langfuse.trace.output"
	attrTraceMetadata     = "langfuse.trace.metadata."
	attrAttempt           = "langfuse.observation.metadata.attempt"
	attrObservationType   = "langfuse.observation.type"
	attrObservationInput  = "langfuse.observation.input"
	attrObservationOutput = "langfuse.observation.output"
	attrObservationLevel  = "langfuse.observation.level"
	attrStatusMessage     = "langfuse.observation.status_message"
)

// quoter is the implementation, as the trace's tags name it.
const quoter = "go"

// observationTypes type each stage for Langfuse's graph of the path.
var observationTypes = map[Stage]string{
	StagePrepare:  "span",
	StageGuard:    "guardrail",
	StageParse:    "chain",
	StageRecount:  "chain",
	StageIdentify: "chain",
	StageJudge:    "evaluator",
	StagePrice:    "span",
}

// startTrace opens the root of a quote's trace: the agent "quote" — one name
// for every quote, so that they group — tagged with the quoter and its
// engines, with who asks, and the cart as received for input. The name, the
// tags, the user and the session go on every observation of the quote
// (Propagated), as the Langfuse SDKs propagate them; the metadata stays on
// the root.
func (p *Pipeline) startTrace(ctx context.Context, req Request) (context.Context, trace.Span) {
	propagated := []attribute.KeyValue{
		attribute.String(attrTraceName, "quote"),
		attribute.StringSlice(attrTraceTags, []string{"quoter:" + quoter, "engines:" + p.Engines.Name}),
	}
	if req.UserID != "" {
		propagated = append(propagated, attribute.String(attrUserID, req.UserID))
	}
	if req.SessionID != "" {
		propagated = append(propagated, attribute.String(attrSessionID, req.SessionID))
	}
	ctx, span := atrace.Tracer.Start(ctx, "quote")
	span.SetAttributes(propagated...)
	span.SetAttributes(
		attribute.String(attrObservationType, "agent"),
		attribute.String(attrTraceInput, req.Cart),
		attribute.String(attrObservationInput, req.Cart),
	)
	if req.RequestID != "" {
		span.SetAttributes(attribute.String(attrTraceMetadata+"request_id", req.RequestID))
	}
	if len(p.Prompts) > 0 {
		span.SetAttributes(attribute.String(attrTraceMetadata+"prompts", promptsJSON(p.Prompts)))
	}
	return context.WithValue(ctx, propagatedKey{}, propagated), span
}

type propagatedKey struct{}

// Propagated is what every observation of the quote under way in ctx
// carries: its trace's name and tags, its user and session. The tracer's
// span processor sets them (telemetry).
func Propagated(ctx context.Context) []attribute.KeyValue {
	kv, _ := ctx.Value(propagatedKey{}).([]attribute.KeyValue)
	return kv
}

// promptsJSON is the prompt versions as /healthz serves them: guard, parse,
// identify, judge, in that order.
func promptsJSON(prompts map[string]string) string {
	var fields []string
	for _, k := range []string{"guard", "parse", "identify", "judge"} {
		if v, ok := prompts[k]; ok {
			fields = append(fields, fmt.Sprintf("%q:%q", k, v))
		}
	}
	return "{" + strings.Join(fields, ",") + "}"
}

// endTrace sets how a quote ended on its root span: the body the API sends
// as output — answer; when empty, a summary of the quote or the problem —
// and the outcome, the readings made and the total as metadata.
func endTrace(span trace.Span, q Quote, err error, m Measures, answer string) {
	if !span.IsRecording() {
		return
	}
	span.SetAttributes(attribute.String(attrTraceMetadata+"outcome", m.Outcome))
	if m.Attempts > 0 {
		span.SetAttributes(attribute.Int(attrTraceMetadata+"attempts", m.Attempts))
	}
	if m.Degraded {
		span.SetAttributes(attribute.String(attrTraceMetadata+"degraded", string(StageRecount)))
	}
	var rej *Rejection
	out := ""
	switch {
	case errors.As(err, &rej):
		out = refusal(rej)
	case err != nil:
		fail(span, err)
		out = jsonString(map[string]string{"code": m.Outcome})
	default: // a quote, and only then its id and total
		span.SetAttributes(attribute.String(attrTraceMetadata+"quote_id", q.ID),
			attribute.Int(attrTraceMetadata+"total_cents", q.Price.TotalCents))
		out = jsonString(map[string]any{"id": q.ID, "lines": q.Price.Lines, "total_cents": q.Price.TotalCents})
	}
	if answer != "" {
		out = answer
	}
	span.SetAttributes(attribute.String(attrTraceOutput, out), attribute.String(attrObservationOutput, out))
}

// startStage opens the span of stage s, typed for the graph; one of a
// reading, attempt says which: a cart read again has a span per stage per
// attempt.
func startStage(ctx context.Context, s Stage, attempt int) (context.Context, trace.Span) {
	ctx, span := atrace.Tracer.Start(ctx, string(s))
	if t, ok := observationTypes[s]; ok {
		span.SetAttributes(attribute.String(attrObservationType, t))
	}
	if attempt > 0 {
		span.SetAttributes(attribute.Int(attrAttempt, attempt))
	}
	return ctx, span
}

// endStage closes a stage's span. A stage that failed but did not fail the
// quote (degraded) is a warning, not an error: the trace of the quote is not
// one of a failure.
func endStage(span trace.Span, out any, err error, degraded bool) {
	defer span.End()
	if !span.IsRecording() {
		return
	}
	var rej *Rejection
	switch {
	case errors.As(err, &rej): // a refusal is the stage's answer, not its failure
		span.SetAttributes(attribute.String(attrObservationOutput, refusal(rej)))
	case err != nil && degraded:
		span.RecordError(err)
		span.SetAttributes(
			attribute.String(attrObservationLevel, "WARNING"),
			attribute.String(attrStatusMessage, "degraded: "+err.Error()),
		)
	case err != nil:
		fail(span, err)
	default:
		span.SetAttributes(attribute.String(attrObservationOutput, jsonString(out)))
	}
}

func refusal(rej *Rejection) string {
	return jsonString(map[string]string{"code": string(rej.Code), "detail": rej.Detail})
}

func fail(span trace.Span, err error) {
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
	span.SetAttributes(
		attribute.String(attrObservationLevel, "ERROR"),
		attribute.String(attrStatusMessage, err.Error()),
	)
}

// jsonString is v in JSON, for a trace. The pipeline's values always
// marshal; one that would not reads as its error.
func jsonString(v any) string {
	b, err := jsonx.Marshal(v)
	if err != nil {
		return err.Error()
	}
	return string(b)
}
