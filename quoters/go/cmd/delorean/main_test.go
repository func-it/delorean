package main

import (
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/config"
)

// A command line that names no command is a usage error (exit code 2), in
// the words every quoter uses.
func TestRunUsageErrors(t *testing.T) {
	for args, want := range map[string]string{
		"deploy":      `unknown command "deploy": want serve, version or tokenizer`,
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
