package config

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/live"
)

func from(vars map[string]string) func(string) string {
	return func(name string) string { return vars[name] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(from(map[string]string{"OPENROUTER_API_KEY": "sk-or-test"}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Port:    24791,
		Engines: EnginesLive,
		Live: live.Config{
			OpenRouterKey:     "sk-or-test",
			ParseModel:        "openai/gpt-6-luna",
			ParseEffort:       "minimal",
			RecountModel:      "openai/gpt-6-luna",
			RecountEffort:     "none",
			ParseBaseURL:      live.OpenRouter,
			RecountBaseURL:    live.OpenRouter,
			IdentifyCacheSize: 10000,
			JevModel:          "typesafe/jev-1.13",
			ModelTimeout:      6 * time.Second,
		},
		MaxBodyBytes:       8192,
		MaxInputTokens:     256,
		GuardMinConfidence: 0.5,
		JudgeThreshold:     0.5,
		ReadAttempts:       3,
		RequestTimeout:     15 * time.Second,
		RecountTimeout:     6 * time.Second,
		FakeLatency:        "off",
	}
	if c != want {
		t.Errorf("Load = %+v\nwant %+v", c, want)
	}
}

func TestLoadEveryVariable(t *testing.T) {
	c, err := Load(from(map[string]string{
		"PORT":                 "9000",
		"ENGINES":              "fake",
		"PARSE_MODEL":          "openai/gpt-6",
		"PARSE_EFFORT":         "high",
		"RECOUNT_MODEL":        "mistralai/mistral-small",
		"RECOUNT_EFFORT":       "medium",
		"PARSE_BASE_URL":       "http://localhost:11434/v1",
		"RECOUNT_BASE_URL":     "http://localhost:11434/v1",
		"PARSE_IDENTIFIES":     "true",
		"IDENTIFY_CACHE_SIZE":  "0",
		"JEV_MODEL":            "typesafe/jev-2",
		"MAX_BODY_BYTES":       "1024",
		"MAX_INPUT_TOKENS":     "512",
		"GUARD_MIN_CONFIDENCE": "0.8",
		"JUDGE_THRESHOLD":      "0.7",
		"READ_ATTEMPTS":        "5",
		"MODEL_TIMEOUT":        "2s",
		"RECOUNT_TIMEOUT":      "3s",
		"REQUEST_TIMEOUT":      "1m30s",
		"FAKE_LATENCY":         "real",
		"FAKE_CPU_MS":          "5",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Port:    9000,
		Engines: EnginesFake,
		Live: live.Config{
			ParseModel:      "openai/gpt-6",
			ParseEffort:     "high",
			RecountModel:    "mistralai/mistral-small",
			RecountEffort:   "medium",
			ParseBaseURL:    "http://localhost:11434/v1",
			RecountBaseURL:  "http://localhost:11434/v1",
			ParseIdentifies: true,
			JevModel:        "typesafe/jev-2",
			ModelTimeout:    2 * time.Second,
		},
		MaxBodyBytes:       1024,
		MaxInputTokens:     512,
		GuardMinConfidence: 0.8,
		JudgeThreshold:     0.7,
		ReadAttempts:       5,
		RequestTimeout:     90 * time.Second,
		RecountTimeout:     3 * time.Second,
		FakeLatency:        "real",
		FakeCPUMs:          5,
	}
	if c != want {
		t.Errorf("Load = %+v\nwant %+v", c, want)
	}
}

func TestLoadFakeNeedsNoKey(t *testing.T) {
	if _, err := Load(from(map[string]string{"ENGINES": "fake"})); err != nil {
		t.Errorf("ENGINES=fake: %v", err)
	}
}

func TestLoadLiveNeedsKey(t *testing.T) {
	_, err := Load(from(nil))
	if err == nil || !strings.Contains(err.Error(), "OPENROUTER_API_KEY is required with ENGINES=live") ||
		!strings.Contains(err.Error(), "ENGINES=fake") {
		t.Errorf("err = %v, want the key required, and the way out", err)
	}
}

func TestLoadSaysEverythingWrong(t *testing.T) {
	_, err := Load(from(map[string]string{
		"PORT":                 "http",
		"ENGINES":              "mock",
		"MAX_BODY_BYTES":       "0",
		"MAX_INPUT_TOKENS":     "-1",
		"GUARD_MIN_CONFIDENCE": "1.5",
		"JUDGE_THRESHOLD":      "NaN",
		"REQUEST_TIMEOUT":      "30",
		"FAKE_LATENCY":         "slow",
		"FAKE_CPU_MS":          "-1",
	}))
	if err == nil {
		t.Fatal("no error")
	}
	want := []string{
		`PORT="http" is not an integer`,
		`REQUEST_TIMEOUT="30" is not a duration such as "30s"`,
		"MAX_BODY_BYTES must be at least 1",
		"MAX_INPUT_TOKENS must be at least 1",
		"GUARD_MIN_CONFIDENCE must be between 0 and 1",
		"JUDGE_THRESHOLD must be between 0 and 1",
		`ENGINES is "mock", want live or fake`,
		`FAKE_LATENCY is "slow", want off or real`,
		"FAKE_CPU_MS must be at least 0",
	}
	if got := strings.Split(err.Error(), "\n"); len(got) != len(want) {
		t.Errorf("%d errors, want %d:\n%v", len(got), len(want), err)
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("err does not say %q:\n%v", w, err)
		}
	}
}

func TestLoadRanges(t *testing.T) {
	for name, value := range map[string]string{
		"PORT":                "65536",
		"REQUEST_TIMEOUT":     "-1s",
		"MODEL_TIMEOUT":       "0s",
		"RECOUNT_TIMEOUT":     "-2s",
		"READ_ATTEMPTS":       "0",
		"IDENTIFY_CACHE_SIZE": "-1",
		"PARSE_EFFORT":        "max",
		"PARSE_BASE_URL":      "localhost:11434",
		"PARSE_IDENTIFIES":    "maybe",
	} {
		if _, err := Load(from(map[string]string{"ENGINES": "fake", name: value})); err == nil || !strings.HasPrefix(err.Error(), name) {
			t.Errorf("%s=%s: err = %v", name, value, err)
		}
	}
}

// Errors come one line per variable, in the order of the configuration
// table, whatever the order of the checks.
func TestLoadListsErrorsInTableOrder(t *testing.T) {
	vars := map[string]string{
		"ENGINES": "fake", "REQUEST_TIMEOUT": "30", "RECOUNT_EFFORT": "x", "PARSE_EFFORT": "y",
		"RECOUNT_BASE_URL": "nowhere", "PARSE_BASE_URL": "ftp://x", "READ_ATTEMPTS": "0", "PORT": "x",
		"MODEL_TIMEOUT": "6", "RECOUNT_TIMEOUT": "0s",
	}
	_, err := Load(func(k string) string { return vars[k] })
	var names []string
	for line := range strings.SplitSeq(err.Error(), "\n") {
		names = append(names, strings.FieldsFunc(line, func(r rune) bool { return r == ' ' || r == '=' })[0])
	}
	want := []string{"PORT", "PARSE_EFFORT", "PARSE_BASE_URL", "RECOUNT_EFFORT", "RECOUNT_BASE_URL", "READ_ATTEMPTS", "MODEL_TIMEOUT", "RECOUNT_TIMEOUT", "REQUEST_TIMEOUT"}
	if !slices.Equal(names, want) {
		t.Errorf("lines for %v, want %v", names, want)
	}
}

// A duration is read in whole milliseconds, and the timeouts are ordered: a
// call, then the recount that holds it, then the request that holds both.
func TestLoadTimeouts(t *testing.T) {
	c, err := Load(from(map[string]string{"ENGINES": "fake", "MODEL_TIMEOUT": "1.1s", "RECOUNT_TIMEOUT": "2.0004s", "REQUEST_TIMEOUT": "0.0036s"}))
	if err == nil || !strings.Contains(err.Error(), "REQUEST_TIMEOUT must be at least RECOUNT_TIMEOUT") {
		t.Fatalf("err = %v, want the request's time under the recount's refused", err)
	}
	c, err = Load(from(map[string]string{"ENGINES": "fake", "MODEL_TIMEOUT": "1.1s", "RECOUNT_TIMEOUT": "2.0004s", "REQUEST_TIMEOUT": "9s"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Live.ModelTimeout != 1100*time.Millisecond || c.RecountTimeout != 2*time.Second {
		t.Errorf("timeouts %v and %v, want 1100ms and 2s: whole milliseconds", c.Live.ModelTimeout, c.RecountTimeout)
	}
	for _, tt := range []struct {
		vars map[string]string
		want string
	}{
		{map[string]string{"MODEL_TIMEOUT": "7s"}, "RECOUNT_TIMEOUT must be at least MODEL_TIMEOUT"},
		{map[string]string{"RECOUNT_TIMEOUT": "20s"}, "REQUEST_TIMEOUT must be at least RECOUNT_TIMEOUT"},
		{map[string]string{"MODEL_TIMEOUT": "20s", "RECOUNT_TIMEOUT": "20s", "REQUEST_TIMEOUT": "10s"}, "REQUEST_TIMEOUT must be at least RECOUNT_TIMEOUT"},
	} {
		tt.vars["ENGINES"] = "fake"
		if _, err := Load(from(tt.vars)); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%v: err = %v, want %q", tt.vars, err, tt.want)
		}
	}
	// a variable that failed its own check is not compared with the others
	_, err = Load(from(map[string]string{"ENGINES": "fake", "RECOUNT_TIMEOUT": "-1s", "REQUEST_TIMEOUT": "1s", "MODEL_TIMEOUT": "9s"}))
	if err == nil || strings.Contains(err.Error(), "must be at least") || !strings.Contains(err.Error(), "RECOUNT_TIMEOUT must be positive") {
		t.Errorf("err = %v, want only RECOUNT_TIMEOUT must be positive", err)
	}
}
