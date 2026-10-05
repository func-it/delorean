package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/config"
	"github.com/func-it/delorean/quoters/go/internal/fake"
	"github.com/func-it/delorean/quoters/go/internal/httpapi"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// A command line that names no command is a usage error (exit code 2), in
// the words every quoter uses.
func TestRunUsageErrors(t *testing.T) {
	for args, want := range map[string]string{
		"deploy":      `unknown command "deploy": want serve, healthcheck, version or tokenizer`,
		"serve extra": `unexpected argument "extra"`,
	} {
		err := run(strings.Fields(args))
		if !errors.As(err, new(usageError)) || err.Error() != want {
			t.Errorf("%s: err = %v, want the usage error %q", args, err, want)
		}
	}
}

// The log's time is UTC with milliseconds, before level and msg.
func TestNewLogger(t *testing.T) {
	var b strings.Builder
	newLogger(&b).Info("listening", "addr", ":1")
	line := b.String()
	if !regexp.MustCompile(`^\{"time":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","level":"INFO","msg":"listening","addr":":1"\}\n$`).MatchString(line) {
		t.Errorf("line = %s", line)
	}
}

func TestServeStopsOnBadConfiguration(t *testing.T) {
	t.Setenv("ENGINES", "live")
	t.Setenv("OPENROUTER_API_KEY", "")
	err := run(nil)
	if err == nil || !strings.Contains(err.Error(), "OPENROUTER_API_KEY is required") {
		t.Errorf("err = %v, want the missing key, before anything starts", err)
	}
}

func TestNewEngines(t *testing.T) {
	e, err := newEngines(config.Config{Engines: config.EnginesFake})
	if err != nil || e.Name != "fake" {
		t.Errorf("fake: %+v, %v", e, err)
	}
}

// serviceOn starts the service's handler on a free port, and says it.
func serviceOn(t *testing.T) string {
	t.Helper()
	h := httpapi.New(httpapi.Config{
		Pipeline:       &pipeline.Pipeline{Engines: fake.New()},
		Version:        "test",
		MaxBodyBytes:   8192,
		RequestTimeout: time.Second,
		Log:            newLogger(&strings.Builder{}),
	})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Port()
}

// healthcheck reads PORT, and only PORT: up is exit 0 and silence, anything
// else is an error that main prints as one line.
func TestHealthcheck(t *testing.T) {
	env := func(port string) func(string) string {
		return func(k string) string {
			if k == "PORT" {
				return port
			}
			t.Errorf("healthcheck read %s: it reads PORT and nothing else", k)
			return ""
		}
	}
	if err := healthcheck(env(serviceOn(t)), time.Second); err != nil {
		t.Errorf("up: err = %v, want nil", err)
	}

	// nothing listening: a port that was just free
	down := httptest.NewServer(http.NotFoundHandler())
	u, _ := url.Parse(down.URL)
	down.Close()
	if err := healthcheck(env(u.Port()), time.Second); err == nil || strings.Contains(err.Error(), "\n") {
		t.Errorf("down: err = %v, want one line", err)
	}

	// an answer that is not a quoter's health
	for name, handler := range map[string]http.HandlerFunc{
		"not found":  http.NotFound,
		"not health": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>`)) },
		"not ok":     func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"status":"starting"}`)) },
	} {
		srv := httptest.NewServer(handler)
		u, _ := url.Parse(srv.URL)
		if err := healthcheck(env(u.Port()), time.Second); err == nil {
			t.Errorf("%s: err = nil, want a failure", name)
		}
		srv.Close()
	}

	for _, port := range []string{"abc", "0", "70000"} {
		if err := healthcheck(env(port), time.Second); err == nil {
			t.Errorf("PORT=%s: err = nil, want a failure", port)
		}
	}
}

// The command is run through run, with an unset PORT meaning the service's
// default, and is no usage error when the service is down.
func TestRunHealthcheckDown(t *testing.T) {
	t.Setenv("PORT", "1")
	err := run([]string{"healthcheck"})
	if err == nil || errors.As(err, new(usageError)) {
		t.Errorf("err = %v, want a failure that is no usage error", err)
	}
}
