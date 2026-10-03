// Package bench plays the live engines against cases whose answer is known,
// and keeps the runs in Langfuse, where they are compared side by side.
//
// The work is split three ways, and each part stays where it belongs:
//   - the cases are files in the repository (cases/<subject>/<id>.json),
//     reviewed and versioned with the code they test, and shared by the
//     three implementations;
//   - trpc-agent-go's evaluation module plays them — the engines are the
//     application's own — and scores them with our checks, registered as
//     evaluators;
//   - Langfuse keeps each case as a dataset item and each pass as an
//     experiment (v4): a trace per case, a score per check, the pass rate of
//     the pass.
//
// A subject is a stage, or stages, of the reading: guard, identify, reading
// (parse and identify), judge. Each is played several times per case: a
// model does not answer twice the same, and one pass proves little.
package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Case is one file of cases/<subject>/: the input of the subject, what its
// answer must show, and why the case exists.
type Case struct {
	ID string `json:"id"`
	// Note says in words why the case exists — which mistake it guards against.
	Note   string          `json:"note"`
	Tags   []string        `json:"tags,omitempty"`
	Input  json.RawMessage `json:"input"`
	Expect json.RawMessage `json:"expect"`
}

// Metric is one check of an answer, scored from 0 to 1. A run passes a case
// when every metric reaches its threshold; a metric at threshold 0 is only
// reported.
type Metric struct {
	Name      string
	Threshold float64
	// Check scores the answer, in JSON, against the case — in code.
	Check func(answer string, c Case) (score float64, reason string)
	// Probe, when set, scores the answer by asking a model instead of Check:
	// the judge, reading what a subject read. A model out of reach is no
	// verdict on the answer: an error leaves the metric unscored.
	Probe func(ctx context.Context, answer string, c Case) (score float64, reason string, err error)
}

// Subject is what a bench plays.
type Subject struct {
	Name        string // the Langfuse dataset, and the folder of its cases
	Description string
	// Variant names what is tested — the models, the versions of the
	// questions and prompts — and goes into the run name, so two runs say
	// what they differ by.
	Variant string
	// Play answers one case's input with the engines under test. The answer
	// is marshalled to JSON for the metrics.
	Play    func(ctx context.Context, input json.RawMessage) (answer any, usage []pipeline.Usage, err error)
	Metrics []Metric
	// readAttempts is the most readings a play makes of a cart, for the
	// subject that reads again.
	readAttempts int
	// Stats counts what the plays and the probes took.
	Stats *Stats
}

// Load reads the cases of a folder, in the order of their ids.
func Load(dir string) ([]Case, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	out := make([]Case, 0, len(paths))
	for _, p := range paths {
		c, err := read(p)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// read reads one case file: its fields and no other, and an id that is its
// file name.
func read(path string) (Case, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Case{}, err
	}
	var c Case
	if err := strict(b, &c); err != nil {
		return Case{}, fmt.Errorf("%s: %w", path, err)
	}
	if want := strings.TrimSuffix(filepath.Base(path), ".json"); c.ID != want {
		return Case{}, fmt.Errorf("%s: id %q, the file must be named %s.json", path, c.ID, c.ID)
	}
	return c, nil
}

// strict decodes JSON that holds only the fields of v, and nothing after it.
func strict(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("text after the JSON value")
	}
	return nil
}

// itemID is the case's id in Langfuse, where item ids are unique across the
// whole project: two subjects may both have a case "bttf-2-roman".
func itemID(subject, caseID string) string { return subject + ":" + caseID }
