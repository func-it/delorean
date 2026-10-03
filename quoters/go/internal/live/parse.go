package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	openaisdk "github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/decide"
	"github.com/func-it/delorean/quoters/go/internal/jsonx"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Parser reads the films a customer buys, and how many copies of each, with
// an LLM under a strict JSON schema: one call to trpc-agent-go's model, no
// agent and no tool, so the cost of a parse does not rest on the model's
// good will. It sends parse.json and nothing else: the instruction as the
// system turn, the fenced message as the user turn, the schema as the
// response format. The recount is a Parser too, on another model: the same
// instruction, schema and fence (prompts/parse.json), a second reading.
//
// Each call is a Langfuse generation of its own, with the tokens and the
// cost OpenRouter bills: an agent's spans would carry the tokens but not the
// cost, which Langfuse would then price from its own table, at 0 for a
// model it does not know.
type Parser struct {
	stage  pipeline.Stage
	model  string
	effort string
	llm    model.Model
	prompt readingPrompt
}

// message is the user turn of one reading: the customer's text, fenced.
func (r readingPrompt) message(text string) string {
	return r.Message.Before + text + r.Message.After
}

// conversation is what a reading sends: the instruction and the fenced
// message; read again, the conversation goes on with the reading that
// failed, as the model's answer, and what failed (the file's retry).
func (r readingPrompt) conversation(text string, again *pipeline.Retry) []model.Message {
	msgs := []model.Message{model.NewSystemMessage(r.Instruction), model.NewUserMessage(r.message(text))}
	if again == nil {
		return msgs
	}
	return append(msgs,
		model.NewAssistantMessage(r.readingJSON(again.Reading)),
		model.NewUserMessage(r.retryTurn(again.Findings)))
}

// readingJSON is a reading as the schema has it, compact, and written as
// JSON.stringify writes it, title, quantity, then film when the file asks
// for it: every implementation sends the same.
func (r readingPrompt) readingJSON(mentions []cart.Mention) string {
	films := make([]string, len(mentions))
	for i, m := range mentions {
		film := ""
		if r.films {
			film = fmt.Sprintf(`,"film":%s`, quoted(string(m.Film)))
		}
		films[i] = fmt.Sprintf(`{"title":%s,"quantity":%d%s}`, quoted(m.Title), m.Quantity, film)
	}
	return `{"films":[` + strings.Join(films, ",") + `]}`
}

// retryTurn says what failed: the file's retry.turn, one retry.finding line
// per check, its placeholders filled in one pass — a title that reads
// {meaning} stays a title.
func (r readingPrompt) retryTurn(findings []pipeline.Finding) string {
	lines := make([]string, len(findings))
	for i, f := range findings {
		lines[i] = strings.NewReplacer("{check}", string(f.Check), "{label}", f.Label,
			"{meaning}", r.Retry.Meanings[f.Check]).Replace(r.Retry.Finding)
	}
	return strings.Replace(r.Retry.Turn, "{findings}", strings.Join(lines, "\n"), 1)
}

// ParsePrompt is all a reading sends about text — its instruction, its
// schema and the message — as one string: what a dry run counts. identifies
// says it is parse-films.json's.
func ParsePrompt(text string, identifies bool) string {
	r := prompts.parse
	if identifies {
		r = prompts.parseFilms
	}
	return r.Instruction + "\n" + jsonOf(r.Schema) + "\n" + r.message(text)
}

// meterKey carries the meter of one parse to the model's response callback:
// the model is shared, the meter is not.
type meterKey struct{}

// meter adds up the model calls of one parse, their tokens and what
// OpenRouter says they cost.
type meter struct {
	mu            sync.Mutex
	calls         int
	cost          float64
	input, output int
	// reported: a response said what it took
	reported bool
}

func (m *meter) add(raw string) {
	var r struct {
		Usage struct {
			Cost             float64 `json:"cost"`
			PromptTokens     int     `json:"prompt_tokens"`
			CompletionTokens int     `json:"completion_tokens"`
		} `json:"usage"`
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if json.Unmarshal([]byte(raw), &r) == nil && strings.Contains(raw, `"usage"`) {
		m.reported = true
		m.cost += r.Usage.Cost
		m.input += r.Usage.PromptTokens
		m.output += r.Usage.CompletionTokens
	}
}

// newParser reads for stage s with the file r, through the model name of the
// OpenAI-compatible API at baseURL, at the reasoning effort given ("none":
// no reasoning field at all).
func newParser(s pipeline.Stage, cfg Config, r readingPrompt, baseURL, name, effort string) *Parser {
	llm := openai.New(name,
		openai.WithAPIKey(cfg.OpenRouterKey),
		openai.WithBaseURL(baseURL),
		openai.WithHeaders(map[string]string{"HTTP-Referer": "https://github.com/func-it/delorean", "X-Title": "delorean"}),
		openai.WithOpenAIOptions(
			// OpenRouter reports the real cost of each call when asked to.
			option.WithJSONSet("usage", map[string]any{"include": true}),
			// The schema rides on the request alone. llmagent's structured
			// output would also write instructions of its own into the system
			// turn, and every word put to the model is prompts/parse.json's.
			option.WithJSONSet("response_format", map[string]any{"type": "json_schema",
				"json_schema": map[string]any{"name": "reading", "strict": true, "schema": r.Schema}}),
			// the client's own retries, which default to two, follow Config.Attempts
			option.WithMaxRetries(max(cfg.Attempts-1, 0)),
		),
		// a pool of connections of its own, kept alive between calls
		openai.WithHTTPClientOptions(model.WithHTTPClientTransport(decide.KeepAlive(8))),
		openai.WithChatResponseCallback(func(ctx context.Context, _ *openaisdk.ChatCompletionNewParams, rsp *openaisdk.ChatCompletion) {
			if m, ok := ctx.Value(meterKey{}).(*meter); ok && rsp != nil {
				m.add(rsp.RawJSON())
			}
		}),
	)
	return &Parser{stage: s, model: name, effort: effort, llm: llm, prompt: r}
}

// Parse reads text; told what failed (again not nil), it reads it again in
// the conversation that read it first.
func (p *Parser) Parse(ctx context.Context, text string, again *pipeline.Retry) ([]cart.Mention, pipeline.Usage, error) {
	start := time.Now()
	m := &meter{}
	var mentions []cart.Mention
	err := p.call(context.WithValue(ctx, meterKey{}, m), p.prompt.conversation(text, again), func(answer string) (err error) {
		mentions, err = decodeReading(answer, p.prompt.films)
		return err
	})
	u := pipeline.Usage{Engine: p.model, Model: p.model, Calls: m.calls, Ms: time.Since(start).Milliseconds(), CostUSD: m.cost}
	if err != nil {
		return nil, u, failed(p.stage, err)
	}
	return mentions, u, nil
}

// maxTokens bounds an answer, reasoning included; a reading is a few hundred.
const maxTokens = 4096

// call makes the one model call of a reading, as a Langfuse generation under
// the stage's span, and hands the answer's text to decode: an answer off its
// schema fails the generation too. The meter in ctx counts the call, its
// tokens and its cost; usage and cost are traced when a response said them.
func (p *Parser) call(ctx context.Context, msgs []model.Message, decode func(answer string) error) (err error) {
	ctx, span := atrace.Tracer.Start(ctx, "chat "+p.model, oteltrace.WithSpanKind(oteltrace.SpanKindClient))
	in, _ := jsonx.Marshal(msgs) // plain data: it always marshals
	params, _ := jsonx.Marshal(map[string]string{"reasoning_effort": p.effort})
	span.SetAttributes(
		attribute.String(attrObservationType, "generation"),
		attribute.String(attrModel, p.model),
		attribute.String(attrModelParameters, string(params)),
		attribute.String(attrObservationInput, string(in)),
	)
	var answer string
	defer func() {
		if m, _ := ctx.Value(meterKey{}).(*meter); m != nil && m.reported {
			span.SetAttributes(
				attribute.String(attrUsageDetails, fmt.Sprintf(`{"input":%d,"output":%d}`, m.input, m.output)),
				attribute.String(attrCostDetails, fmt.Sprintf(`{"total":%g}`, m.cost)))
		}
		if answer != "" {
			span.SetAttributes(attribute.String(attrObservationOutput, answer))
		}
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			span.SetAttributes(attribute.String(attrObservationLevel, "ERROR"), attribute.String(attrStatusMessage, err.Error()))
		}
		span.End()
	}()

	tokens := maxTokens
	cfg := model.GenerationConfig{MaxTokens: &tokens}
	if p.effort != "none" { // a model without reasoning refuses the field
		cfg.ReasoningEffort = &p.effort
	}
	rsps, err := p.llm.GenerateContent(ctx, &model.Request{Messages: msgs, GenerationConfig: cfg})
	if err != nil {
		return err
	}
	var failure error
	for rsp := range rsps {
		if rsp == nil {
			continue
		}
		if rsp.Error != nil {
			failure = fmt.Errorf("%s: %s", rsp.Error.Type, rsp.Error.Message)
		}
		if !rsp.IsPartial && len(rsp.Choices) > 0 && strings.TrimSpace(rsp.Choices[0].Message.Content) != "" {
			answer = rsp.Choices[0].Message.Content
		}
	}
	if failure != nil {
		return failure
	}
	if answer == "" {
		return errors.New("no answer")
	}
	return decode(answer)
}

// decodeReading holds the answer to its schema: JSON and nothing else, a
// list of films, each with a title and at least one copy. The schema is
// asked of the model, not trusted from it.
func decodeReading(answer string, films bool) ([]cart.Mention, error) {
	dec := json.NewDecoder(strings.NewReader(answer))
	dec.DisallowUnknownFields()
	var r struct {
		Films *[]cart.Mention `json:"films"`
	}
	if err := dec.Decode(&r); err != nil {
		return nil, fmt.Errorf("answer off schema: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("answer off schema: text after the JSON")
	}
	if r.Films == nil {
		return nil, errors.New("answer off schema: no films")
	}
	read := *r.Films
	for i := range read {
		m := &read[i]
		m.Title = strings.TrimSpace(m.Title)
		switch {
		case m.Title == "":
			return nil, fmt.Errorf("answer off schema: film %d has no title", i+1)
		case m.Quantity < 1:
			return nil, fmt.Errorf("answer off schema: %q has quantity %d", m.Title, m.Quantity)
		case films && !m.Film.Valid():
			return nil, fmt.Errorf("answer off schema: %q is the film %q", m.Title, m.Film)
		case !films && m.Film != "":
			return nil, fmt.Errorf("answer off schema: %q has a film, which the schema does not ask", m.Title)
		}
	}
	return read, nil
}
