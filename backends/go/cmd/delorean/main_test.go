package main

import (
	"strings"
	"testing"

	"github.com/bn-k/delorean/backends/go/internal/config"
)

func TestRunUnknownCommand(t *testing.T) {
	if err := run([]string{"deploy"}); err == nil || !strings.Contains(err.Error(), `unknown command "deploy"`) {
		t.Errorf("err = %v", err)
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
