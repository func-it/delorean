package live

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/cart"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// fixturePrompts puts a small prompt set in place of the repository's for
// one test, before any parser is built: a test then checks how a request is
// assembled, not the wording, which lives in prompts/ alone.
func fixturePrompts(t *testing.T) {
	t.Helper()
	saved := prompts
	t.Cleanup(func() { prompts = saved })
	prompts.parse.Instruction = "INSTRUCTION"
	prompts.parse.Message.Before, prompts.parse.Message.After = "<<\n", "\n>>"
	prompts.parse.Retry.Turn = "FAILED:\n{findings}\nAGAIN"
	prompts.parse.Retry.Finding = "{check}|{label}|{meaning}"
	prompts.parse.Retry.Meanings = map[pipeline.Check]string{
		pipeline.CheckAsked: "A", pipeline.CheckIdentity: "I", pipeline.CheckMissing: "M", pipeline.CheckCount: "C"}
}

// chatServer stands in for OpenRouter's chat completions: every call is
// answered with content as the assistant's message, at the given cost. It
// returns the parser pointed at it and the requests it saw.
func chatServer(t *testing.T, status int, content string, cost float64) (*Parser, func() []map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body: %v", err)
		}
		body["path"], body["authorization"] = r.URL.Path, r.Header.Get("Authorization")
		mu.Lock()
		seen = append(seen, body)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		msg, _ := json.Marshal(content)
		if _, err := w.Write([]byte(`{"id":"gen-1","object":"chat.completion","created":1,"model":"openai/gpt-6-luna",` +
			`"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":` + string(msg) + `}}],` +
			`"usage":{"prompt_tokens":420,"completion_tokens":30,"total_tokens":450,"cost":` + jsonNumber(cost) + `}}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return newParser(pipeline.StageParse, Config{OpenRouterKey: "k"}, prompts.parse, srv.URL+"/api/v1", DefaultParseModel, DefaultParseEffort),
		func() []map[string]any { mu.Lock(); defer mu.Unlock(); return append([]map[string]any(nil), seen...) }
}

func jsonNumber(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

// One call to the parsing model: its id and reasoning effort, the strict
// schema, OpenRouter's cost asked for; the customer's text fenced in the user
// turn, the instruction apart, and not a word that is not parse.json's. The answer becomes mentions; the cost is the
// one OpenRouter reports.
func TestParserMakesOneStructuredCall(t *testing.T) {
	fixturePrompts(t)
	text := "Mon fils adore Retour vers le futur 2, j'en prends deux. Et La chèvre."
	p, seen := chatServer(t, 200, `{"films":[{"title":"Retour vers le futur 2","quantity":2},{"title":"La chèvre","quantity":1}]}`, 0.00021)
	mentions, u, err := p.Parse(context.Background(), text, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []cart.Mention{{Title: "Retour vers le futur 2", Quantity: 2}, {Title: "La chèvre", Quantity: 1}}
	if len(mentions) != len(want) || mentions[0] != want[0] || mentions[1] != want[1] {
		t.Errorf("mentions %+v", mentions)
	}
	if u.Engine != DefaultParseModel || u.Model != DefaultParseModel || u.Calls != 1 || u.CostUSD != 0.00021 {
		t.Errorf("usage %+v", u)
	}
	reqs := seen()
	if len(reqs) != 1 {
		t.Fatalf("%d calls", len(reqs))
	}
	r := reqs[0]
	if r["path"] != "/api/v1/chat/completions" || r["authorization"] != "Bearer k" || r["model"] != DefaultParseModel ||
		r["reasoning_effort"] != DefaultParseEffort || r["max_completion_tokens"] != 4096.0 || r["max_tokens"] != nil {
		t.Errorf("request %v", r)
	}
	if usage, _ := r["usage"].(map[string]any); usage["include"] != true {
		t.Errorf("OpenRouter's cost not asked for: %v", r["usage"])
	}
	format, _ := r["response_format"].(map[string]any)
	schema, _ := format["json_schema"].(map[string]any)
	if format["type"] != "json_schema" || schema["strict"] != true {
		t.Errorf("response format %v", format)
	}
	msgs, _ := r["messages"].([]any)
	var system, user string
	for _, m := range msgs {
		m := m.(map[string]any)
		content, _ := m["content"].(string)
		switch m["role"] {
		case "system":
			system += content
		case "user":
			user += content
		}
	}
	if len(msgs) != 2 || system != "INSTRUCTION" || user != "<<\n"+text+"\n>>" {
		t.Errorf("system %q, user %q", system, user)
	}
	if !reflect.DeepEqual(schema["schema"], prompts.parse.Schema) {
		t.Errorf("schema %v, want parse.json's", schema["schema"])
	}
}

// Read again, the conversation goes on: the instruction, the fenced
// message, the reading that failed as the model's answer — compact JSON as
// JSON.stringify writes it — and what failed, from parse.json's retry, in
// the judgement's order.
func TestParserReadsAgainToldWhatFailed(t *testing.T) {
	fixturePrompts(t)
	text := "Heat\nLa chèvre <3"
	p, seen := chatServer(t, 200, `{"films":[{"title":"Heat","quantity":1},{"title":"La chèvre <3","quantity":1}]}`, 0)
	again := &pipeline.Retry{
		Reading: []cart.Mention{{Title: "Heat", Quantity: 1}, {Title: `Le "Doc" <&>`, Quantity: 2}},
		Findings: []pipeline.Finding{
			{Check: pipeline.CheckIdentity, Label: "Le {meaning}", Score: 0.2}, // filled in one pass: stays a title
			{Check: pipeline.CheckMissing, Label: pipeline.WholeReading, Score: 0.1},
			{Check: pipeline.CheckCount, Label: "other: 3 read, 2 recounted", Score: 0},
		},
	}
	mentions, _, err := p.Parse(context.Background(), text, again)
	if err != nil || len(mentions) != 2 {
		t.Fatalf("mentions %+v, %v", mentions, err)
	}
	msgs, _ := seen()[0]["messages"].([]any)
	var turns []string
	for _, m := range msgs {
		m := m.(map[string]any)
		content, _ := m["content"].(string)
		turns = append(turns, m["role"].(string)+": "+content)
	}
	want := []string{
		"system: INSTRUCTION",
		"user: <<\n" + text + "\n>>",
		`assistant: {"films":[{"title":"Heat","quantity":1},{"title":"Le \"Doc\" <&>","quantity":2}]}`,
		"user: FAILED:\nidentity|Le {meaning}|I\nmissing|the whole reading|M\ncount|other: 3 read, 2 recounted|C\nAGAIN",
	}
	if !reflect.DeepEqual(turns, want) {
		t.Errorf("turns:\n%s\nwant:\n%s", strings.Join(turns, "\n---\n"), strings.Join(want, "\n---\n"))
	}
}

// The recount is a reading of its own: its model, its effort, its stage in
// the errors.
func TestRecountReadsOnItsOwnModel(t *testing.T) {
	var seen map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
			t.Errorf("request body: %v", err)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	r := newParser(pipeline.StageRecount, Config{OpenRouterKey: "k"}, prompts.parse, srv.URL+"/api/v1", DefaultRecountModel, "medium")
	_, u, err := r.Parse(context.Background(), "BTTF 2", nil)
	isEngineErr(t, err)
	if !strings.HasPrefix(err.Error(), "recount: ") || u.Model != DefaultRecountModel {
		t.Errorf("err %v, usage %+v", err, u)
	}
	if seen["model"] != DefaultRecountModel || seen["reasoning_effort"] != "medium" {
		t.Errorf("request %v", seen)
	}
}

// Each call is a Langfuse generation: the model, what was sent and
// answered, the tokens, and the cost OpenRouter bills — never left to
// Langfuse's own price table, which knows no OpenRouter model.
func TestParserTracesAGenerationWithItsCost(t *testing.T) {
	spans := recordSpans(t)
	p, _ := chatServer(t, 200, `{"films":[{"title":"Heat","quantity":2}]}`, 0.00021)
	if _, _, err := p.Parse(context.Background(), "2 x Heat", nil); err != nil {
		t.Fatal(err)
	}
	ended := spans.Ended()
	if len(ended) != 1 || ended[0].Name() != "chat "+DefaultParseModel {
		t.Fatalf("spans %v, want one generation", ended)
	}
	attrs := map[string]string{}
	for _, kv := range ended[0].Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	for k, want := range map[string]string{
		"langfuse.observation.type":             "generation",
		"langfuse.observation.model.name":       DefaultParseModel,
		"langfuse.observation.cost_details":     `{"total":0.00021}`,
		"langfuse.observation.usage_details":    `{"input":420,"output":30}`,
		"langfuse.observation.output":           `{"films":[{"title":"Heat","quantity":2}]}`,
		"langfuse.observation.model.parameters": `{"reasoning_effort":"minimal"}`,
	} {
		if attrs[k] != want {
			t.Errorf("%s = %q, want %q", k, attrs[k], want)
		}
	}
	if !strings.Contains(attrs["langfuse.observation.input"], "2 x Heat") {
		t.Errorf("input %q", attrs["langfuse.observation.input"])
	}
}

// An empty list is a reading — the pipeline answers no_film; anything off
// the schema is an engine failure.
func TestParserHoldsTheAnswerToItsSchema(t *testing.T) {
	p, _ := chatServer(t, 200, `{"films":[]}`, 0)
	if m, _, err := p.Parse(context.Background(), "Bonjour", nil); err != nil || len(m) != 0 {
		t.Errorf("empty reading: %v, %v", m, err)
	}
	for _, answer := range []string{
		`Here are the films: {"films":[]}`,
		`{"films":[{"title":"BTTF 2","quantity":0}]}`,
		`{"films":[{"title":"  ","quantity":1}]}`,
		`{"films":[{"title":"BTTF 2","quantity":1.5}]}`,
		`{"films":[{"title":"BTTF 2","quantity":1,"price":0}]}`,
		`{"films":[{"title":"BTTF 2","quantity":1}]} {"films":[]}`,
		`{"movies":[]}`,
	} {
		p, _ := chatServer(t, 200, answer, 0)
		_, _, err := p.Parse(context.Background(), "BTTF 2", nil)
		isEngineErr(t, err)
	}
}

// An answer off its schema fails its generation, which still shows it; a
// call with no response traces no usage.
func TestParserGenerationFailsOffSchema(t *testing.T) {
	spans := recordSpans(t)
	p, _ := chatServer(t, 200, `{"movies":[]}`, 0.0001)
	_, _, err := p.Parse(context.Background(), "Heat", nil)
	isEngineErr(t, err)
	g := spans.Ended()[0]
	attrs := map[string]string{}
	for _, kv := range g.Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	if attrs["langfuse.observation.level"] != "ERROR" || attrs["langfuse.observation.output"] != `{"movies":[]}` {
		t.Errorf("generation %v, want ERROR with the answer", attrs)
	}
	spans = recordSpans(t)
	down, _ := chatServer(t, 503, "", 0)
	_, _, _ = down.Parse(context.Background(), "Heat", nil)
	for _, kv := range spans.Ended()[0].Attributes() {
		if kv.Key == "langfuse.observation.usage_details" || kv.Key == "langfuse.observation.cost_details" {
			t.Errorf("%s = %s on a call that failed", kv.Key, kv.Value.AsString())
		}
	}
}

// In the request path a failure is answered at once: no retry of the
// client's own, a customer is waiting.
func TestParserDoesNotRetryInTheRequestPath(t *testing.T) {
	p, seen := chatServer(t, 503, "", 0)
	_, _, err := p.Parse(context.Background(), "BTTF 2", nil)
	isEngineErr(t, err)
	if n := len(seen()); n != 1 {
		t.Errorf("%d calls, want 1", n)
	}
}

// With effort none the request carries no reasoning field: a model without
// reasoning refuses one (Ollama: "does not support thinking").
func TestParserWithoutReasoning(t *testing.T) {
	var seen map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"1","object":"chat.completion","created":1,"model":"llama3.2:3b","choices":[{"index":0,` +
			`"finish_reason":"stop","message":{"role":"assistant","content":"{\"films\":[]}"}}]}`))
	}))
	t.Cleanup(srv.Close)
	p := newParser(pipeline.StageParse, Config{}, prompts.parse, srv.URL+"/v1", "llama3.2:3b", "none")
	if _, _, err := p.Parse(context.Background(), "Bonjour", nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := seen["reasoning_effort"]; ok || seen["model"] != "llama3.2:3b" {
		t.Errorf("request %v", seen)
	}
}

// Identifying, the parse reads with parse-films.json: each line with its
// film, which must be one of the four. A plain reading has none.
func TestParserIdentifies(t *testing.T) {
	reads := func(identifies bool, answer string) ([]cart.Mention, map[string]any, error) {
		var seen map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&seen)
			msg, _ := json.Marshal(answer)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"1","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,` +
				`"finish_reason":"stop","message":{"role":"assistant","content":` + string(msg) + `}}]}`))
		}))
		t.Cleanup(srv.Close)
		r := prompts.parse
		if identifies {
			r = prompts.parseFilms
		}
		m, _, err := newParser(pipeline.StageParse, Config{}, r, srv.URL+"/v1", "m", "low").Parse(context.Background(), "BTTF 2", nil)
		return m, seen, err
	}
	m, seen, err := reads(true, `{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}]}`)
	if err != nil || len(m) != 1 || m[0].Film != cart.BTTF2 {
		t.Fatalf("mentions %+v, %v", m, err)
	}
	format, _ := seen["response_format"].(map[string]any)
	if schema, _ := format["json_schema"].(map[string]any); !reflect.DeepEqual(schema["schema"], prompts.parseFilms.Schema) {
		t.Errorf("schema %v, want parse-films.json's", schema["schema"])
	}
	for identifies, answer := range map[bool]string{
		true:  `{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_4"}]}`,
		false: `{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}]}`,
	} {
		if _, _, err := reads(identifies, answer); err == nil {
			t.Errorf("identifies %v: %s read", identifies, answer)
		}
	}
	again := prompts.parseFilms.readingJSON([]cart.Mention{{Title: "BTTF 2", Quantity: 1, Film: cart.BTTF2}})
	if again != `{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}]}` {
		t.Errorf("a reading read again: %s", again)
	}
}

// One reader keeps its connections alive: calls one after the other open
// one connection, not one each.
func TestParserReusesItsConnection(t *testing.T) {
	var mu sync.Mutex
	opened := 0
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"1","object":"chat.completion","created":1,"model":"m","choices":[{"index":0,` +
			`"finish_reason":"stop","message":{"role":"assistant","content":"{\"films\":[]}"}}]}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			mu.Lock()
			opened++
			mu.Unlock()
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	p := newParser(pipeline.StageParse, Config{}, prompts.parse, srv.URL+"/v1", "m", "none")
	for range 5 {
		if _, _, err := p.Parse(context.Background(), "Bonjour", nil); err != nil {
			t.Fatal(err)
		}
	}
	if opened != 1 {
		t.Errorf("%d connections for 5 calls", opened)
	}
}
