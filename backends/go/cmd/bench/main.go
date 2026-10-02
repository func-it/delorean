// bench plays the live engines against the shared cases (cases/), and keeps
// the runs in Langfuse. Run it from backends/go, or set CASES_DIR.
//
//	go run ./cmd/bench list
//	go run ./cmd/bench check
//	go run ./cmd/bench run guard [--runs 3] [--name …] [--desc …] [--dry-run]
//
// check is offline and belongs in CI. run calls OpenRouter and Langfuse, and
// refuses to unless RUN_LIVE=1, OPENROUTER_API_KEY and Langfuse are set;
// --dry-run counts what it would send, offline.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/bench"
	"github.com/bn-k/delorean/backends/go/internal/config"
	"github.com/bn-k/delorean/backends/go/internal/live"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
	"github.com/bn-k/delorean/backends/go/internal/prepare"
	"github.com/bn-k/delorean/backends/go/internal/telemetry"
)

const usage = "usage: bench list | check | run <subject> [--runs 3] [--name …] [--desc …] [--dry-run]"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	switch args[0] {
	case "list":
		return list()
	case "check":
		return check()
	case "run":
		return benchRun(args[1:])
	}
	return fmt.Errorf("bench %s: unknown\n%s", args[0], usage)
}

func casesDir() string {
	if d := os.Getenv("CASES_DIR"); d != "" {
		return d
	}
	return filepath.Join("..", "..", "cases")
}

func list() error {
	for _, name := range bench.Names() {
		cases, err := bench.Load(filepath.Join(casesDir(), name))
		if err != nil {
			return err
		}
		fmt.Printf("%-9s %3d cases  %s\n", name, len(cases), bench.Subjects[name])
	}
	quote, err := bench.Load(filepath.Join(casesDir(), "quote"))
	if err != nil {
		return err
	}
	fmt.Printf("%-9s %3d cases  The API end to end: played by the system bench (e2e/), checked here.\n", "quote", len(quote))
	return nil
}

func check() error {
	problems, err := bench.Validate(casesDir())
	if err != nil {
		return err
	}
	for _, p := range problems {
		fmt.Println(p)
	}
	if len(problems) > 0 {
		return fmt.Errorf("%d problems in %s", len(problems), casesDir())
	}
	n := 0
	for _, f := range bench.Folders() {
		cases, err := bench.Load(filepath.Join(casesDir(), f))
		if err != nil {
			return err
		}
		n += len(cases)
	}
	fmt.Printf("%d cases in %s, all well formed\n", n, casesDir())
	return nil
}

func benchRun(args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("which subject? %s", strings.Join(bench.Names(), ", "))
	}
	name, args := args[0], args[1:]
	if _, ok := bench.Subjects[name]; !ok {
		return fmt.Errorf("subject %q unknown (%s)", name, strings.Join(bench.Names(), ", "))
	}
	fs := flag.NewFlagSet("bench run", flag.ContinueOnError)
	runs := fs.Int("runs", 3, "passes over every case")
	runName := fs.String("name", "", "name of the runs in Langfuse (default: the variant and the time)")
	desc := fs.String("desc", "", "what this run tests")
	dryRun := fs.Bool("dry-run", false, "count the calls and tokens a run would send, offline")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *runs < 1 {
		return errors.New("--runs: at least 1")
	}
	cases, err := bench.Load(filepath.Join(casesDir(), name))
	if err != nil {
		return err
	}
	cfg, err := configuration()
	if err != nil {
		return err
	}
	if *dryRun {
		return dry(name, cases, *runs, cfg)
	}

	lf, err := ready(cfg)
	if err != nil {
		return err
	}
	cfg.Live.Attempts = 4 // a bench waits out a rate limit rather than failing a case
	engines, err := live.New(cfg.Live)
	if err != nil {
		return err
	}
	s, err := bench.NewSubject(name, setup(cfg, engines))
	if err != nil {
		return err
	}
	// every model call of the bench goes to Langfuse, under its case
	shutdown, _, err := telemetry.Start(context.Background())
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := shutdown(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "langfuse: flushing the traces:", err)
		}
	}()

	fmt.Printf("%s · %s · %d cases × %d runs\n", name, s.Variant, len(cases), *runs)
	rep, err := bench.Run(context.Background(), s, lf, cases, bench.Options{Runs: *runs, Name: *runName, Description: *desc})
	if err != nil {
		return err
	}
	printReport(os.Stdout, lf, rep)
	fmt.Println(s.Stats)
	return nil
}

// configuration reads the service's settings as the server does: the
// models, the effort, the guard's and the judge's thresholds. A bench plays the live engines
// whatever ENGINES says, and a dry run needs no key: ready says what a live
// run lacks, all of it at once.
func configuration() (config.Config, error) {
	return config.Load(func(k string) string {
		if k == "ENGINES" {
			return config.EnginesFake // no key required here
		}
		return os.Getenv(k)
	})
}

// ready refuses a live run until everything it needs is set, and says all
// that is missing at once. It returns the Langfuse API the bench writes to.
func ready(cfg config.Config) (*bench.Langfuse, error) {
	var missing []string
	if os.Getenv("RUN_LIVE") != "1" {
		missing = append(missing, "RUN_LIVE=1 is not set")
	}
	if cfg.Live.OpenRouterKey == "" {
		missing = append(missing, "OPENROUTER_API_KEY is not set")
	}
	lf, ok, err := telemetry.FromEnv()
	switch {
	case err != nil:
		missing = append(missing, err.Error())
	case !ok:
		missing = append(missing, "Langfuse is not configured: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("bench run calls OpenRouter and writes to Langfuse, and refuses to start:\n  - %s\n"+
			"--dry-run counts what it would send, offline", strings.Join(missing, "\n  - "))
	}
	return &bench.Langfuse{BaseURL: lf.BaseURL, PublicKey: lf.PublicKey, SecretKey: lf.SecretKey}, nil
}

// setup names the models of the engines, for the variant of the runs.
func setup(cfg config.Config, e pipeline.Engines) bench.Setup {
	return bench.Setup{
		Engines:            e,
		Jev:                path.Base(cfg.Live.JevModel),
		LLM:                fmt.Sprintf("%s (%s)", path.Base(cfg.Live.ParseModel), cfg.Live.ParseEffort),
		GuardMinConfidence: cfg.GuardMinConfidence,
		JudgeThreshold:     cfg.JudgeThreshold,
	}
}

func dry(name string, cases []bench.Case, runs int, cfg config.Config) error {
	counter, err := prepare.NewCounter()
	if err != nil {
		return err
	}
	est, err := bench.DryRun(context.Background(), name, setup(cfg, pipeline.Engines{}), cases, counter.Count)
	if err != nil {
		return err
	}
	about := ""
	if est.Approximate {
		about = " — titles counted from what the cases expect; the parse may read more"
	}
	fmt.Printf("%s · %s · %d cases × %d runs — dry run, nothing sent\n", name, est.Variant, len(cases), runs)
	fmt.Printf("  calls:  %d Jev, %d LLM%s\n", est.Jev*runs, est.LLM*runs, about)
	fmt.Printf("  input:  ≈ %d tokens (%s; Jev's tokenizer is not published)\n", est.Tokens*runs, prepare.Encoding)
	return nil
}
