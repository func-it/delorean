// Package config reads the service's settings from the environment
// (docs/architecture.md, "Configuration") and says everything that is wrong
// with them before anything starts. Langfuse is configured apart, by
// internal/telemetry.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/live"
)

// The engines a service runs on.
const (
	EnginesLive = "live"
	EnginesFake = "fake"
)

// Config is the service's configuration.
type Config struct {
	Port int
	// Engines is EnginesLive, the models through OpenRouter, or EnginesFake,
	// deterministic stand-ins for tests.
	Engines string
	// Live configures the live engines; unused by the fake ones.
	Live               live.Config
	MaxBodyBytes       int64
	MaxInputTokens     int
	GuardMinConfidence float64
	JudgeThreshold     float64
	// ReadAttempts is the most readings of one cart before it is refused as
	// unfaithful, the first included.
	ReadAttempts int
	// RequestTimeout is the budget of one request, model calls included.
	RequestTimeout time.Duration
	// FakeLatency is "off", fakes that answer at once, or "real", fakes
	// that take a model's time (the load bench).
	FakeLatency string
	// FakeCPUMs is how long each fake call keeps a processor busy.
	FakeCPUMs int
}

// Load reads the configuration through getenv, os.Getenv but in tests. Its
// error lists every variable that is wrong, one per line.
func Load(getenv func(string) string) (Config, error) {
	e := env{getenv: getenv}
	c := Config{
		Port:    e.int("PORT", 24791),
		Engines: e.string("ENGINES", EnginesLive),
		Live: live.Config{
			OpenRouterKey:     getenv("OPENROUTER_API_KEY"),
			ParseModel:        e.string("PARSE_MODEL", "openai/gpt-6-luna"),
			ParseEffort:       e.string("PARSE_EFFORT", "minimal"),
			ParseBaseURL:      e.string("PARSE_BASE_URL", live.OpenRouter),
			ParseIdentifies:   e.bool("PARSE_IDENTIFIES", false),
			RecountModel:      e.string("RECOUNT_MODEL", "deepseek/deepseek-v4.1-flash"),
			RecountEffort:     e.string("RECOUNT_EFFORT", "low"),
			RecountBaseURL:    e.string("RECOUNT_BASE_URL", live.OpenRouter),
			JevModel:          e.string("JEV_MODEL", "typesafe/jev-1.13"),
			IdentifyCacheSize: e.int("IDENTIFY_CACHE_SIZE", 10000),
		},
		MaxBodyBytes:       int64(e.int("MAX_BODY_BYTES", 65536)),
		MaxInputTokens:     e.int("MAX_INPUT_TOKENS", 2048),
		GuardMinConfidence: e.float("GUARD_MIN_CONFIDENCE", 0.5),
		JudgeThreshold:     e.float("JUDGE_THRESHOLD", 0.5),
		ReadAttempts:       e.int("READ_ATTEMPTS", 3),
		RequestTimeout:     e.duration("REQUEST_TIMEOUT", 30*time.Second),
		FakeLatency:        e.string("FAKE_LATENCY", "off"),
		FakeCPUMs:          e.int("FAKE_CPU_MS", 0),
	}

	e.check(c.Port >= 1 && c.Port <= 65535, "PORT", "must be between 1 and 65535")
	e.check(c.MaxBodyBytes >= 1, "MAX_BODY_BYTES", "must be at least 1")
	e.check(c.MaxInputTokens >= 1, "MAX_INPUT_TOKENS", "must be at least 1")
	e.check(c.GuardMinConfidence >= 0 && c.GuardMinConfidence <= 1, "GUARD_MIN_CONFIDENCE", "must be between 0 and 1")
	e.check(c.JudgeThreshold >= 0 && c.JudgeThreshold <= 1, "JUDGE_THRESHOLD", "must be between 0 and 1")
	e.check(c.ReadAttempts >= 1, "READ_ATTEMPTS", "must be at least 1")
	e.check(c.Live.IdentifyCacheSize >= 0, "IDENTIFY_CACHE_SIZE", "must be at least 0 (0 turns the cache off)")
	for _, v := range []struct{ name, effort string }{{"PARSE_EFFORT", c.Live.ParseEffort}, {"RECOUNT_EFFORT", c.Live.RecountEffort}} {
		e.check(slices.Contains(live.Efforts, v.effort), v.name, fmt.Sprintf("is %q, want one of %s", v.effort, strings.Join(live.Efforts, ", ")))
	}
	for _, v := range []struct{ name, base string }{{"PARSE_BASE_URL", c.Live.ParseBaseURL}, {"RECOUNT_BASE_URL", c.Live.RecountBaseURL}} {
		u, err := url.Parse(v.base)
		e.check(err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "", v.name, fmt.Sprintf("is %q, not an http(s) URL", v.base))
	}
	e.check(c.RequestTimeout > 0, "REQUEST_TIMEOUT", "must be positive")
	e.check(c.FakeLatency == "off" || c.FakeLatency == "real", "FAKE_LATENCY", fmt.Sprintf("is %q, want off or real", c.FakeLatency))
	e.check(c.FakeCPUMs >= 0, "FAKE_CPU_MS", "must be at least 0")
	switch c.Engines {
	case EnginesFake:
	case EnginesLive:
		e.check(c.Live.OpenRouterKey != "", "OPENROUTER_API_KEY",
			"is required with ENGINES=live; set it, or run ENGINES=fake for the deterministic test engines")
	default:
		e.check(false, "ENGINES", fmt.Sprintf("is %q, want %s or %s", c.Engines, EnginesLive, EnginesFake))
	}
	return c, e.err()
}

// Variables are the variables Load reads, in the order of the
// configuration table (docs/architecture.md): the order of its error lines.
var Variables = []string{
	"PORT", "ENGINES", "OPENROUTER_API_KEY",
	"PARSE_MODEL", "PARSE_EFFORT", "PARSE_BASE_URL", "PARSE_IDENTIFIES",
	"RECOUNT_MODEL", "RECOUNT_EFFORT", "RECOUNT_BASE_URL", "JEV_MODEL",
	"MAX_BODY_BYTES", "MAX_INPUT_TOKENS", "GUARD_MIN_CONFIDENCE", "JUDGE_THRESHOLD",
	"READ_ATTEMPTS", "IDENTIFY_CACHE_SIZE", "REQUEST_TIMEOUT", "FAKE_LATENCY", "FAKE_CPU_MS",
}

// env reads typed variables and collects what is wrong with them.
type env struct {
	getenv func(string) string
	errs   map[string]error
}

func (e *env) fail(name string, err error) {
	if e.errs == nil {
		e.errs = map[string]error{}
	}
	if _, ok := e.errs[name]; !ok { // one line per variable
		e.errs[name] = err
	}
}

// err is every problem, one line per variable, in the table's order.
func (e *env) err() error {
	var errs []error
	for _, name := range Variables {
		errs = append(errs, e.errs[name])
	}
	return errors.Join(errs...)
}

func (e *env) check(ok bool, name, problem string) {
	if !ok {
		e.fail(name, fmt.Errorf("%s %s", name, problem))
	}
}

func (e *env) string(name, def string) string {
	if v := e.getenv(name); v != "" {
		return v
	}
	return def
}

// parsed reads name with parse, or def when it is unset.
func parsed[T any](e *env, name string, def T, parse func(string) (T, error), want string) T {
	v := e.getenv(name)
	if v == "" {
		return def
	}
	x, err := parse(v)
	if err != nil {
		e.fail(name, fmt.Errorf("%s=%q is not %s", name, v, want))
		return def
	}
	return x
}

func (e *env) bool(name string, def bool) bool {
	return parsed(e, name, def, strconv.ParseBool, "true or false")
}

func (e *env) int(name string, def int) int {
	return parsed(e, name, def, strconv.Atoi, "an integer")
}

func (e *env) float(name string, def float64) float64 {
	return parsed(e, name, def, func(s string) (float64, error) { return strconv.ParseFloat(s, 64) }, "a number")
}

func (e *env) duration(name string, def time.Duration) time.Duration {
	return parsed(e, name, def, time.ParseDuration, `a duration such as "30s"`)
}
