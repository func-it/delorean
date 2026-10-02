package decide

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"
)

// HTTP is an engine reached over the Jev protocol: POST {model, state,
// questions}, answered with {id, answers, usage}.
type HTTP struct {
	Name    string // the engine, as Engine reports it
	URL     string
	Model   string // sent as "model"
	Key     string // bearer token
	Headers map[string]string
	Client  *http.Client
}

const (
	// JevModel is the version of Jev delorean is tuned on, frozen.
	JevModel = "typesafe/jev-1.13"
	jevURL   = "https://openrouter.ai/api/alpha/decisions"
)

// Jev is TypeSafe's model through OpenRouter; model "" is JevModel. It is not
// on chat/completions: it lives on /api/alpha/decisions.
func Jev(key, model string) *HTTP {
	if model == "" {
		model = JevModel
	}
	return &HTTP{
		Name: path.Base(model), URL: jevURL, Model: model, Key: key,
		Headers: map[string]string{"HTTP-Referer": "https://github.com/bn-k/delorean", "X-Title": "delorean"},
		Client:  &http.Client{Timeout: 20 * time.Second},
	}
}

func (h *HTTP) Engine() string { return h.Name }

type wireResponse struct {
	ID      string            `json:"id"`
	Answers map[string]Answer `json:"answers"`
	Usage   struct {
		Cost float64 `json:"cost"`
		// the token counts, under either spelling OpenRouter uses
		InputTokens      int `json:"input_tokens"`
		PromptTokens     int `json:"prompt_tokens"`
		OutputTokens     int `json:"output_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Decide sends one request and checks the answer. Each call is a span: under
// Langfuse it is a generation with its input, its answers, its cost and its
// tokens; with no tracer set up it costs nothing.
func (h *HTTP) Decide(ctx context.Context, r Request) (d Decision, err error) {
	if h.Key == "" {
		return Decision{}, ErrNoKey
	}
	start := time.Now()
	qs := make(map[string]any, len(r.Questions))
	for _, q := range r.Questions {
		qs[q.Key] = q.wire()
	}
	raw, err := json.Marshal(map[string]any{"model": h.Model, "state": r.State, "questions": qs})
	if err != nil {
		return Decision{}, fmt.Errorf("%s: %w", h.Name, err)
	}

	ctx, span := atrace.Tracer.Start(ctx, "decide "+h.Name, oteltrace.WithSpanKind(oteltrace.SpanKindClient))
	span.SetAttributes(
		attribute.String("langfuse.observation.type", "generation"),
		attribute.String("gen_ai.system", h.Name),
		attribute.String("gen_ai.request.model", h.Model),
		attribute.String("langfuse.observation.model.name", h.Model),
		attribute.String("langfuse.observation.input", string(raw)),
	)
	defer func() {
		d.Ms = time.Since(start).Milliseconds()
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			span.SetAttributes(attribute.String("langfuse.observation.level", "ERROR"),
				attribute.String("langfuse.observation.status_message", err.Error()))
		} else {
			out, _ := json.Marshal(d.Answers) // answers decoded from JSON marshal back
			span.SetAttributes(attribute.String("langfuse.observation.output", string(out)),
				attribute.Float64("gen_ai.usage.cost", d.Cost),
				attribute.String("langfuse.observation.cost_details", fmt.Sprintf(`{"total":%g}`, d.Cost)))
			if d.InputTokens > 0 || d.OutputTokens > 0 {
				span.SetAttributes(attribute.String("langfuse.observation.usage_details",
					fmt.Sprintf(`{"input":%d,"output":%d}`, d.InputTokens, d.OutputTokens)))
			}
		}
		span.End()
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(raw))
	if err != nil {
		return Decision{}, fmt.Errorf("%s: %w", h.Name, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.Key)
	for k, v := range h.Headers {
		req.Header.Set(k, v)
	}
	c := h.Client
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Do(req)
	if err != nil {
		return Decision{}, fmt.Errorf("%s: %w", h.Name, err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 256<<10))
	if err != nil {
		return Decision{}, fmt.Errorf("%s: status %d: %w", h.Name, res.StatusCode, err)
	}

	var out wireResponse
	if jerr := json.Unmarshal(b, &out); jerr != nil {
		return Decision{}, fmt.Errorf("%s: status %d: bad JSON: %w", h.Name, res.StatusCode, jerr)
	}
	if res.StatusCode != http.StatusOK || out.Error != nil {
		msg := ""
		if out.Error != nil {
			msg = out.Error.Message
		}
		return Decision{}, fmt.Errorf("%s: status %d: %s", h.Name, res.StatusCode, msg)
	}
	d = Decision{Answers: out.Answers, Cost: out.Usage.Cost, ID: out.ID, Engine: h.Name, Model: h.Model,
		InputTokens:  cmp.Or(out.Usage.InputTokens, out.Usage.PromptTokens),
		OutputTokens: cmp.Or(out.Usage.OutputTokens, out.Usage.CompletionTokens)}
	if err := check(r, d); err != nil {
		return Decision{}, err
	}
	return d, nil
}

// ErrNoKey is returned by Jev without a key, before any call.
var ErrNoKey = errors.New("decide: missing API key")
