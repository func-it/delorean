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
			RecountModel:      "deepseek/deepseek-v4.1-flash",
			RecountEffort:     "low",
			ParseBaseURL:      live.OpenRouter,
			RecountBaseURL:    live.OpenRouter,
			IdentifyCacheSize: 10000,
			JevModel:          "typesafe/jev-1.13",
		},
		MaxBodyBytes:       65536,
		MaxInputTokens:     2048,
		GuardMinConfidence: 0.5,
		JudgeThreshold:     0.5,
		ReadAttempts:       3,
		RequestTimeout:     30 * time.Second,
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
		},
		MaxBodyBytes:       1024,
		MaxInputTokens:     512,
		GuardMinConfidence: 0.8,
		JudgeThreshold:     0.7,
		ReadAttempts:       5,
		RequestTimeout:     90 * time.Second,
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
	}
	_, err := Load(func(k string) string { return vars[k] })
	var names []string
	for line := range strings.SplitSeq(err.Error(), "\n") {
		names = append(names, strings.FieldsFunc(line, func(r rune) bool { return r == ' ' || r == '=' })[0])
	}
	want := []string{"PORT", "PARSE_EFFORT", "PARSE_BASE_URL", "RECOUNT_EFFORT", "RECOUNT_BASE_URL", "READ_ATTEMPTS", "REQUEST_TIMEOUT"}
	if !slices.Equal(names, want) {
		t.Errorf("lines for %v, want %v", names, want)
	}
}
