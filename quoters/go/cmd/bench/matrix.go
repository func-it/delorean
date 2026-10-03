package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"maps"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/bench"
	"github.com/func-it/delorean/quoters/go/internal/config"
	"github.com/func-it/delorean/quoters/go/internal/live"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
	"github.com/func-it/delorean/quoters/go/internal/prepare"
)

// modelsAPI is OpenRouter's list of models and their prices: a GET without
// key, at no cost. MODELS_API overrides it, for the tests.
const modelsAPI = "https://openrouter.ai/api/v1/models"

// matrix benches a subject once per variant of a variants file — each one
// a Langfuse experiment named after it — and compares them in one table,
// printed and written as Markdown beside each variant's JSON report
// (reports/<date>/). --dry-run runs nothing: it estimates each variant's
// cost from the token counts and OpenRouter's prices.
func matrix(args []string) error {
	fs := flag.NewFlagSet("bench matrix", flag.ContinueOnError)
	subject := fs.String("subject", "parse", "the subject every variant plays")
	file := fs.String("variants", filepath.Join("bench", "variants.yaml"), "the variants: name and environment overrides")
	runs := fs.Int("runs", 3, "passes over every case, per variant")
	dryRun := fs.Bool("dry-run", false, "estimate each variant's cost, offline but for OpenRouter's prices")
	maxUSD := fs.Float64("max-usd", 0, "stop starting plays once the whole matrix has cost this much (0: no cap)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *maxUSD < 0 {
		return errors.New("--max-usd: at least 0")
	}
	if _, ok := bench.Subjects[*subject]; !ok {
		return fmt.Errorf("subject %q unknown (%s)", *subject, strings.Join(bench.Names(), ", "))
	}
	if *runs < 1 {
		return errors.New("--runs: at least 1")
	}
	variants, err := bench.LoadVariants(*file)
	if err != nil {
		return err
	}
	cases, err := bench.Load(filepath.Join(casesDir(), bench.Folder(*subject)))
	if err != nil {
		return err
	}
	date := time.Now().Format("2006-01-02")
	dir := filepath.Join(reportsDir(), date)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if *dryRun {
		return matrixDry(*subject, variants, cases, *runs, dir)
	}

	base, err := configuration(nil)
	if err != nil {
		return err
	}
	lf, err := ready(base)
	if err != nil {
		return err
	}
	defer startTraces()()
	var rows []bench.Row
	spent := 0.0
	for _, v := range variants {
		cfg, err := configuration(v.Env)
		if err != nil {
			return fmt.Errorf("variant %s: %w", v.Name, err)
		}
		if *maxUSD > 0 && spent >= *maxUSD { // the cap is reached: the variant is not started
			row := describe(v, cfg)
			row.CutShort = true
			rows = append(rows, row)
			fmt.Printf("%s: not run, the matrix has spent $%.4f of $%.4f\n", v.Name, spent, *maxUSD)
			continue
		}
		engines, err := benchEngines(cfg)
		if err != nil {
			return fmt.Errorf("variant %s: %w", v.Name, err)
		}
		s, err := bench.NewSubject(*subject, setup(cfg, engines))
		if err != nil {
			return err
		}
		fmt.Printf("%s · %s · %s · %d cases × %d runs\n", v.Name, *subject, s.Variant, len(cases), *runs)
		opt := bench.Options{Runs: *runs, Name: v.Name, Description: v.Note}
		if *maxUSD > 0 {
			opt.MaxUSD = *maxUSD - spent
		}
		rep, err := bench.Run(context.Background(), s, lf, cases, opt)
		if err != nil {
			return fmt.Errorf("variant %s: %w", v.Name, err)
		}
		spent += rep.Cost
		if rep.LangfuseErrors > 0 {
			fmt.Printf("%s: %d calls to Langfuse failed; its results are computed here\n", v.Name, rep.LangfuseErrors)
		}
		row := bench.RowOf(describe(v, cfg), rep, s.Stats.Summary())
		rows = append(rows, row)
		if err := writeJSON(filepath.Join(dir, *subject+"-"+v.Name+".json"), variantReport(*subject, v, s, rep, row)); err != nil {
			return err
		}
		// the table so far, after each variant: a matrix stopped half-way
		// leaves the comparison of what it ran
		if err := os.WriteFile(filepath.Join(dir, *subject+"-matrix.md"),
			[]byte(heading(*subject, date, len(cases), *runs, false)+"\n"+bench.Table(rows)), 0o644); err != nil {
			return err
		}
	}
	return writeTable(filepath.Join(dir, *subject+"-matrix.md"), heading(*subject, date, len(cases), *runs, false), rows)
}

// table rebuilds a matrix's table from the variants' JSON reports of a day
// (reports/<date>/<subject>-<variant>.json), offline, in the order of the
// variants file: a matrix that stopped half-way, or that wrote no table,
// is compared all the same.
func table(args []string) error {
	fs := flag.NewFlagSet("bench table", flag.ContinueOnError)
	subject := fs.String("subject", "parse", "the subject of the matrix")
	date := fs.String("date", time.Now().Format("2006-01-02"), "the day of the reports, reports/<date>/")
	file := fs.String("variants", filepath.Join("bench", "variants.yaml"), "the variants, for the order of the rows")
	if err := fs.Parse(args); err != nil {
		return err
	}
	variants, err := bench.LoadVariants(*file)
	if err != nil {
		return err
	}
	dir := filepath.Join(reportsDir(), *date)
	var rows []bench.Row
	cases, runs := 0, 0
	versions := map[string]bool{}
	for _, v := range variants {
		b, err := os.ReadFile(filepath.Join(dir, *subject+"-"+v.Name+".json"))
		if errors.Is(err, os.ErrNotExist) {
			continue // not run
		}
		if err != nil {
			return err
		}
		var r struct {
			Row    bench.Row `json:"row"`
			Tested string    `json:"tested"`
			Cases  []struct {
				Runs int `json:"runs"`
			} `json:"cases"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return fmt.Errorf("%s: %w", v.Name, err)
		}
		rows = append(rows, r.Row)
		cases = max(cases, len(r.Cases))
		if len(r.Cases) > 0 {
			runs = max(runs, r.Cases[0].Runs)
		}
		for _, m := range promptVersion.FindAllString(r.Tested, -1) {
			versions[m] = true
		}
	}
	if len(rows) == 0 {
		return fmt.Errorf("no report of %s in %s", *subject, dir)
	}
	tested := slices.Sorted(maps.Keys(versions))
	head := fmt.Sprintf("# %s matrix, %s\n\n%d cases × %d runs, measured; %d of %d variants run.\nPrompts: %s.\n",
		*subject, *date, cases, runs, len(rows), len(variants), strings.Join(tested, ", "))
	return writeTable(filepath.Join(dir, *subject+"-matrix.md"), head, rows)
}

// promptVersion is a stage's version as a subject's variant names it.
var promptVersion = regexp.MustCompile(`(parse|identify|judge|guard|recount) [0-9a-f]{8}`)

// heading says what a matrix's table compares: the subject, the date, the
// cases and runs, and the prompts' versions.
func heading(subject, date string, cases, runs int, dry bool) string {
	what := "measured"
	if dry {
		what = "estimated by a dry run, nothing sent: prices from OpenRouter's models API, reasoning tokens not " +
			fmt.Sprintf("counted, a local model free, Jev at $%.5f a call", bench.JevCallUSD)
	}
	return fmt.Sprintf("# %s matrix, %s\n\n%d cases × %d runs, %s.\nPrompts: parse %s (parse-films %s), identify %s.\n",
		subject, date, cases, runs, what, live.ParseVersion(false), live.ParseVersion(true), live.Version(pipeline.StageIdentify))
}

// writeTable prints a matrix's table under its heading, and writes it as
// Markdown to path.
func writeTable(path, head string, rows []bench.Row) error {
	doc := head + "\n" + bench.Table(rows)
	fmt.Println("\n" + doc)
	fmt.Println("written to", path)
	return os.WriteFile(path, []byte(doc), 0o644)
}

// matrixDry estimates each variant: the calls and tokens of one pass, at
// the prices OpenRouter's models API gives, a local model free; Jev's calls
// at bench.JevCallUSD. It refuses a model that cannot answer under a strict
// schema.
func matrixDry(subject string, variants []bench.Variant, cases []bench.Case, runs int, dir string) error {
	counter, err := prepare.NewCounter()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	prices, err := bench.FetchPrices(ctx, cmp.Or(os.Getenv("MODELS_API"), modelsAPI))
	if err != nil {
		return fmt.Errorf("OpenRouter's prices: %w", err)
	}
	var rows []bench.Row
	for _, v := range variants {
		cfg, err := configuration(v.Env)
		if err != nil {
			return fmt.Errorf("variant %s: %w", v.Name, err)
		}
		row := describe(v, cfg)
		price, ok := prices[cfg.Live.ParseModel]
		switch {
		case row.Local:
		case !ok:
			return fmt.Errorf("variant %s: %s is not on OpenRouter", v.Name, cfg.Live.ParseModel)
		case !price.StructuredOutputs:
			return fmt.Errorf("variant %s: %s cannot answer under a strict JSON schema", v.Name, cfg.Live.ParseModel)
		}
		est, err := bench.DryRun(context.Background(), subject, setup(cfg, pipeline.Engines{}), cases, counter.Count)
		if err != nil {
			return err
		}
		rows = append(rows, bench.EstimatedRow(row, est, len(cases), price))
	}
	var total float64
	for _, r := range rows {
		total += r.CostPerCart * float64(len(cases)*runs)
	}
	date := filepath.Base(dir)
	head := heading(subject, date, len(cases), runs, true) + fmt.Sprintf("≈ $%.4f for the whole matrix.\n", total)
	return writeTable(filepath.Join(dir, subject+"-matrix-dry-run.md"), head, rows)
}

// describe is what a variant is, for its row: the parse's model, effort and
// strategy, and whether it answers on this machine.
func describe(v bench.Variant, cfg config.Config) bench.Row {
	strategy := "parse + identify"
	if cfg.Live.ParseIdentifies {
		strategy = "the parse identifies"
	}
	u, _ := url.Parse(cfg.Live.ParseBaseURL) // config.Load checked it
	host := u.Hostname()
	return bench.Row{Variant: v.Name, Model: path.Base(cfg.Live.ParseModel), Effort: cfg.Live.ParseEffort, Strategy: strategy,
		Local: host == "localhost" || host == "127.0.0.1" || host == "::1"}
}

// variantReport is one variant's JSON report: what it is, its row, and each
// case's runs.
func variantReport(subject string, v bench.Variant, s *bench.Subject, rep *bench.Report, row bench.Row) any {
	type caseRuns struct {
		ID      string   `json:"id"`
		Passed  int      `json:"passed"`
		Runs    int      `json:"runs"`
		Reasons []string `json:"reasons,omitempty"`
	}
	var cases []caseRuns
	for _, id := range rep.Cases {
		c := caseRuns{ID: id, Runs: len(rep.Scores[id])}
		for _, sc := range rep.Scores[id] {
			if sc.Passed {
				c.Passed++
				continue
			}
			for _, why := range sc.Reasons {
				c.Reasons = append(c.Reasons, why)
			}
		}
		cases = append(cases, c)
	}
	return map[string]any{
		"subject": subject, "variant": v.Name, "note": v.Note, "env": v.Env, "tested": s.Variant,
		"row": row, "summary": s.Stats.Summary(), "cases": cases,
	}
}

func reportsDir() string {
	return cmp.Or(os.Getenv("REPORTS_DIR"), filepath.Join("..", "..", "reports"))
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}
