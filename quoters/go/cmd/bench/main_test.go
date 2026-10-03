package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/bench"
	"github.com/func-it/delorean/quoters/go/internal/live"
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
	if err := run([]string{"run", "price"}); err == nil || !strings.Contains(err.Error(), "guard, identify, judge, parse, reading") {
		t.Errorf("unknown subject: %v", err)
	}
}

// A matrix's dry run needs the cases, the variants and OpenRouter's prices
// (MODELS_API, a stub here); a model without structured outputs is refused.
func TestMatrixDryRun(t *testing.T) {
	unset(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"openai/gpt-6-luna","pricing":{"prompt":"0.0000001","completion":"0.0000005"},` +
			`"supported_parameters":["structured_outputs"]},{"id":"qwen/qwen3.7-flash","pricing":{"prompt":"0","completion":"0"},` +
			`"supported_parameters":["response_format"]}]}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("MODELS_API", srv.URL)
	variants := filepath.Join(t.TempDir(), "variants.yaml")
	write := func(body string) {
		if err := os.WriteFile(variants, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("variants:\n  - name: luna-low\n    env: {PARSE_MODEL: openai/gpt-6-luna}\n" +
		"  - name: luna-identifies\n    env: {PARSE_MODEL: openai/gpt-6-luna, PARSE_IDENTIFIES: \"true\"}\n" +
		"  - name: local\n    env: {PARSE_MODEL: \"llama3.2:3b\", PARSE_EFFORT: none, PARSE_BASE_URL: \"http://localhost:11434/v1\"}\n")
	reports := t.TempDir()
	t.Setenv("REPORTS_DIR", reports)
	if err := run([]string{"matrix", "--subject", "parse", "--variants", variants, "--runs", "1", "--dry-run"}); err != nil {
		t.Fatal(err)
	}
	// the table, under a heading that says the date, the runs and the
	// prompts, in reports/<date>/
	date := time.Now().Format("2006-01-02")
	b, err := os.ReadFile(filepath.Join(reports, date, "parse-matrix-dry-run.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# parse matrix, " + date, "× 1 runs", "Prompts: parse " + live.ParseVersion(false),
		"| luna-identifies |", "| local |"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("the table does not say %q:\n%s", want, b)
		}
	}
	if err := run([]string{"matrix", "--variants", variants, "--max-usd", "-1", "--dry-run"}); err == nil {
		t.Error("a negative cap accepted")
	}
	write("variants:\n  - name: qwen\n    env: {PARSE_MODEL: qwen/qwen3.7-flash}\n")
	err = run([]string{"matrix", "--subject", "parse", "--variants", variants, "--dry-run"})
	if err == nil || !strings.Contains(err.Error(), "cannot answer under a strict JSON schema") {
		t.Errorf("err %v", err)
	}
}

// The variants of the repository read, and estimate, without a key.
func TestTheRepositorysVariants(t *testing.T) {
	if _, err := bench.LoadVariants(filepath.Join("..", "..", "bench", "variants.yaml")); err != nil {
		t.Fatal(err)
	}
}

// bench table rebuilds a matrix's table from a day's JSON reports, in the
// order of the variants, and says which ran.
func TestTableFromTheReports(t *testing.T) {
	unset(t)
	reports := t.TempDir()
	t.Setenv("REPORTS_DIR", reports)
	day := filepath.Join(reports, "2026-10-03")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	variants := filepath.Join(t.TempDir(), "variants.yaml")
	if err := os.WriteFile(variants, []byte("variants:\n  - name: b\n    env: {}\n  - name: a\n    env: {}\n  - name: c\n    env: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"a", "b"} {
		report := `{"row":{"variant":"` + v + `","model":"m","passed":2,"scored":3},"tested":"m · parse 23abf308 · identify fae24511",` +
			`"cases":[{"id":"x","passed":2,"runs":3}]}`
		if err := os.WriteFile(filepath.Join(day, "parse-"+v+".json"), []byte(report), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := run([]string{"table", "--date", "2026-10-03", "--variants", variants}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(day, "parse-matrix.md"))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(b)
	for _, want := range []string{"# parse matrix, 2026-10-03", "1 cases × 3 runs, measured; 2 of 3 variants run.",
		"Prompts: identify fae24511, parse 23abf308."} {
		if !strings.Contains(doc, want) {
			t.Errorf("table does not say %q:\n%s", want, doc)
		}
	}
	if strings.Index(doc, "| b |") > strings.Index(doc, "| a |") {
		t.Errorf("rows out of the variants' order:\n%s", doc)
	}
}
