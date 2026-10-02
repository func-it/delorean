package pipeline

import (
	"context"
	"encoding/json"
	"errors"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"
)

// The attributes Langfuse reads off OpenTelemetry spans
// (trpc-agent-go, telemetry/langfuse/attribute.go).
const (
	attrTraceName         = "langfuse.trace.name"
	attrUserID            = "langfuse.user.id"
	attrSessionID         = "langfuse.session.id"
	attrTraceInput        = "langfuse.trace.input"
	attrTraceOutput       = "langfuse.trace.output"
	attrQuoteID           = "langfuse.trace.metadata.quote_id"
	attrObservationType   = "langfuse.observation.type"
	attrObservationOutput = "langfuse.observation.output"
	attrObservationLevel  = "langfuse.observation.level"
	attrStatusMessage     = "langfuse.observation.status_message"
)

// observationTypes are the stages Langfuse has a kind of observation for;
// the others are plain spans.
var observationTypes = map[Stage]string{
	StageGuard: "guardrail",
	StageJudge: "evaluator",
}

// startTrace opens the root span of a reading: the Langfuse trace "quote",
// named after the quote it may become, with who asks.
func startTrace(ctx context.Context, quoteID string, req Request) (context.Context, trace.Span) {
	ctx, span := atrace.Tracer.Start(ctx, "quote")
	span.SetAttributes(
		attribute.String(attrTraceName, "quote · "+quoteID),
		attribute.String(attrQuoteID, quoteID),
		attribute.String(attrTraceInput, req.Cart),
	)
	if req.UserID != "" {
		span.SetAttributes(attribute.String(attrUserID, req.UserID))
	}
	if req.SessionID != "" {
		span.SetAttributes(attribute.String(attrSessionID, req.SessionID))
	}
	return ctx, span
}

// endTrace sets the outcome of a reading on its root span: the total, the
// refusal, or the failure.
func endTrace(span trace.Span, q Quote, err error) {
	if !span.IsRecording() {
		return
	}
	var rej *Rejection
	switch {
	case errors.As(err, &rej):
		span.SetAttributes(attribute.String(attrTraceOutput, refusal(rej)))
	case err != nil:
		fail(span, err)
	default:
		span.SetAttributes(attribute.String(attrTraceOutput, jsonString(map[string]any{
			"id": q.ID, "lines": q.Price.Lines, "total_cents": q.Price.TotalCents,
		})))
	}
}

func startStage(ctx context.Context, s Stage) (context.Context, trace.Span) {
	ctx, span := atrace.Tracer.Start(ctx, string(s))
	if t, ok := observationTypes[s]; ok {
		span.SetAttributes(attribute.String(attrObservationType, t))
	}
	return ctx, span
}

func endStage(span trace.Span, out any, err error) {
	defer span.End()
	if !span.IsRecording() {
		return
	}
	var rej *Rejection
	switch {
	case errors.As(err, &rej): // a refusal is the stage's answer, not its failure
		span.SetAttributes(attribute.String(attrObservationOutput, refusal(rej)))
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
	b, err := json.Marshal(v)
	if err != nil {
		return err.Error()
	}
	return string(b)
}
