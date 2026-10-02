package config

import (
	"strings"
	"testing"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/live"
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
			OpenRouterKey: "sk-or-test",
			ParseModel:    "openai/gpt-6-luna",
			ParseEffort:   "low",
			JevModel:      "typesafe/jev-1.13",
		},
		MaxBodyBytes:       65536,
		MaxInputTokens:     2048,
		GuardMinConfidence: 0.5,
		JudgeThreshold:     0.5,
		RequestTimeout:     30 * time.Second,
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
		"JEV_MODEL":            "typesafe/jev-2",
		"MAX_BODY_BYTES":       "1024",
		"MAX_INPUT_TOKENS":     "512",
		"GUARD_MIN_CONFIDENCE": "0.8",
		"JUDGE_THRESHOLD":      "0.7",
		"REQUEST_TIMEOUT":      "1m30s",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := Config{
		Port:               9000,
		Engines:            EnginesFake,
		Live:               live.Config{ParseModel: "openai/gpt-6", ParseEffort: "high", JevModel: "typesafe/jev-2"},
		MaxBodyBytes:       1024,
		MaxInputTokens:     512,
		GuardMinConfidence: 0.8,
		JudgeThreshold:     0.7,
		RequestTimeout:     90 * time.Second,
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
		"PORT":            "65536",
		"REQUEST_TIMEOUT": "-1s",
	} {
		if _, err := Load(from(map[string]string{"ENGINES": "fake", name: value})); err == nil || !strings.HasPrefix(err.Error(), name) {
			t.Errorf("%s=%s: err = %v", name, value, err)
		}
	}
}
