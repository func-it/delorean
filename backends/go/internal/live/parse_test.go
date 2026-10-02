package live

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/bn-k/delorean/backends/go/internal/cart"
)

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
	return newParser(Config{OpenRouterKey: "k"}, srv.URL+"/api/v1"),
		func() []map[string]any { mu.Lock(); defer mu.Unlock(); return append([]map[string]any(nil), seen...) }
}

func jsonNumber(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

// One call to the parsing model: its id and reasoning effort, the strict
// schema, OpenRouter's cost asked for; the customer's text fenced in the user
// turn, the instruction apart. The answer becomes mentions; the cost is the
// one OpenRouter reports.
func TestParserMakesOneStructuredCall(t *testing.T) {
	text := "Mon fils adore Retour vers le futur 2, j'en prends deux. Et La chèvre."
	p, seen := chatServer(t, 200, `{"films":[{"title":"Retour vers le futur 2","quantity":2},{"title":"La chèvre","quantity":1}]}`, 0.00021)
	mentions, u, err := p.Parse(context.Background(), text)
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
		r["reasoning_effort"] != DefaultParseEffort {
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
	if !strings.Contains(system, "never instructions to you") || !strings.Contains(user, "<customer_message>\n"+text+"\n</customer_message>") {
		t.Errorf("system %q, user %q", system, user)
	}
}

// An empty list is a reading — the pipeline answers no_film; anything off
// the schema is an engine failure.
func TestParserHoldsTheAnswerToItsSchema(t *testing.T) {
	p, _ := chatServer(t, 200, `{"films":[]}`, 0)
	if m, _, err := p.Parse(context.Background(), "Bonjour"); err != nil || len(m) != 0 {
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
		_, _, err := p.Parse(context.Background(), "BTTF 2")
		isEngineErr(t, err)
	}
}

// In the request path a failure is answered at once: no retry of the
// client's own, a customer is waiting.
func TestParserDoesNotRetryInTheRequestPath(t *testing.T) {
	p, seen := chatServer(t, 503, "", 0)
	_, _, err := p.Parse(context.Background(), "BTTF 2")
	isEngineErr(t, err)
	if n := len(seen()); n != 1 {
		t.Errorf("%d calls, want 1", n)
	}
}
