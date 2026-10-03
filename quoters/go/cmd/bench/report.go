package main

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/bench"
)

// printReport is the bench as the terminal shows it: each case, each metric
// passed in how many runs and its mean score, the lowest confidence the
// engine gave when its answers carry one, then the runs, what failed and
// why, and what could not be scored.
func printReport(w io.Writer, lf *bench.Langfuse, rep *bench.Report) {
	conf := false
	for _, id := range rep.Cases {
		if _, ok := rep.MinConfidence(id); ok {
			conf = true
			break
		}
	}
	var reported []string
	fmt.Fprintf(w, "\n%-32s", "case")
	for _, m := range rep.Metrics {
		fmt.Fprintf(w, " %9s %10s", m, "mean score")
		if rep.Thresholds[m] == 0 {
			reported = append(reported, m)
		}
	}
	if conf {
		fmt.Fprintf(w, " %8s", "min conf")
	}
	fmt.Fprintf(w, " %7s\n", "passed")
	total, passed := 0, 0
	for _, id := range rep.Cases {
		fmt.Fprintf(w, "%-32s", id)
		for _, m := range rep.Metrics {
			// a metric only reported passes every run: count the runs it got right
			pass := rep.Thresholds[m]
			if pass == 0 {
				pass = 1
			}
			ok, seen, sum := 0, 0, 0.0
			for _, sc := range rep.Scores[id] {
				v, has := sc.Scores[m] // unscored runs are listed apart
				if !has {
					continue
				}
				seen++
				sum += v
				if v >= pass-1e-9 {
					ok++
				}
			}
			mean := "-"
			if seen > 0 {
				mean = fmt.Sprintf("%.2f", sum/float64(seen))
			}
			fmt.Fprintf(w, " %9s %10s", fmt.Sprintf("%d/%d", ok, seen), mean)
		}
		if conf {
			low := "-"
			if c, ok := rep.MinConfidence(id); ok {
				low = fmt.Sprintf("%.2f", c)
			}
			fmt.Fprintf(w, " %8s", low)
		}
		ok, played := 0, 0
		for _, sc := range rep.Scores[id] {
			if sc.Skipped {
				continue
			}
			played++
			if sc.Passed {
				ok++
			}
		}
		total += played
		passed += ok
		fmt.Fprintf(w, " %7s\n", fmt.Sprintf("%d/%d", ok, played))
	}
	fmt.Fprintln(w, "\nEach metric: the runs that reached its threshold, of the runs scored, then its mean score")
	fmt.Fprintln(w, "from 0 to 1 — a score, not the engine's confidence.")
	if len(reported) > 0 {
		fmt.Fprintf(w, "%s: reported only, fails no case; counts the runs it got right.\n", strings.Join(reported, ", "))
	}
	if conf {
		fmt.Fprintln(w, "min conf: the lowest confidence the engine gave the case, across the runs.")
	}
	fmt.Fprintln(w)
	for _, r := range rep.Runs {
		if r.Err != nil {
			fmt.Fprintf(w, "%s: FAILED — %v\n", r.Name, r.Err)
			continue
		}
		fmt.Fprintf(w, "%s: %.0f %% of cases passed — %s\n", r.Name, r.PassRate*100, lf.RunURL(rep.Dataset, r.ID))
	}
	if f := rep.Failed(); len(f) > 0 {
		fmt.Fprintln(w, "\nFailed:")
		for _, l := range f {
			fmt.Fprintln(w, "  "+l)
		}
	}
	if u := rep.Unscored(); len(u) > 0 {
		fmt.Fprintln(w, "\nNot evaluated (neither passed nor failed):")
		for _, l := range u {
			fmt.Fprintln(w, "  "+l)
		}
	}
	fmt.Fprintf(w, "\n%d/%d passed · %.5f USD · %s\nCompare the runs: %s\n",
		passed, total, rep.Cost, rep.Duration.Round(time.Second), lf.DatasetURL(rep.Dataset))
	if rep.CutShort {
		fmt.Fprintf(w, "CUT SHORT: the spend reached --max-usd, %d plays were not started.\n", rep.Skipped)
	}
	if rep.LangfuseErrors > 0 {
		fmt.Fprintf(w, "Langfuse: %d calls failed; the results above are computed here and stand without them.\n", rep.LangfuseErrors)
	}
}
