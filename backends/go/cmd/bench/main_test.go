package main

import (
	"strings"
	"testing"
)

// unset clears the environment a live run needs, and points at the
// repository's cases.
func unset(t *testing.T) {
	t.Helper()
	t.Setenv("CASES_DIR", "../../../../cases")
	for _, k := range []string{"RUN_LIVE", "OPENROUTER_API_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
		"LANGFUSE_BASE_URL", "LANGFUSE_HOST"} {
		t.Setenv(k, "")
	}
}

// Without RUN_LIVE, a key and Langfuse, a run refuses before any call and
// says everything it lacks.
func TestRunRefusesUntilEverythingIsSet(t *testing.T) {
	unset(t)
	err := run([]string{"run", "guard"})
	if err == nil {
		t.Fatal("a live run started")
	}
	for _, want := range []string{"RUN_LIVE=1 is not set", "OPENROUTER_API_KEY is not set", "Langfuse is not configured", "--dry-run"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("refusal %q does not say %q", err, want)
		}
	}
}

// check and a dry run need nothing but the cases: CI runs them.
func TestOfflineCommandsNeedNothing(t *testing.T) {
	unset(t)
	for _, args := range [][]string{{"check"}, {"list"}, {"run", "reading", "--dry-run", "--runs", "1"}} {
		if err := run(args); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	if err := run([]string{"run", "price"}); err == nil || !strings.Contains(err.Error(), "guard, identify, judge, reading") {
		t.Errorf("unknown subject: %v", err)
	}
}
