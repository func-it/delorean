package bench

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
	"trpc.group/trpc-go/trpc-agent-go/evaluation"
	evalresultinmemory "trpc.group/trpc-go/trpc-agent-go/evaluation/evalresult/inmemory"
	"trpc.group/trpc-go/trpc-agent-go/evaluation/evalset"
	evalsetinmemory "trpc.group/trpc-go/trpc-agent-go/evaluation/evalset/inmemory"
	"trpc.group/trpc-go/trpc-agent-go/evaluation/evaluator"
	"trpc.group/trpc-go/trpc-agent-go/evaluation/evaluator/registry"
	"trpc.group/trpc-go/trpc-agent-go/evaluation/metric"
	"trpc.group/trpc-go/trpc-agent-go/evaluation/status"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/runner"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"
)

const appName = "delorean-bench"

// Options of one bench.
type Options struct {
	// Runs is how many times every case is played. A model does not answer
	// twice the same: one pass proves little, three show a rate.
	Runs int
	// Name prefixes the runs; empty, it is the variant and the time.
	Name        string
	Description string
}

// Report is what a bench found, case by case and run by run.
type Report struct {
	Dataset Dataset
	Runs    []RunResult
	Cases   []string            // case ids, in order
	Scores  map[string][]Scored // case id → one entry per run
	Metrics []string
	// Thresholds are the metrics' own: a score passes at its threshold, not
	// only at 1 — the judge's scores are probabilities.
	Thresholds map[string]float64
	Cost       float64
	Duration   time.Duration
}

// RunResult is one pass over the dataset.
type RunResult struct {
	Name     string
	ID       string // the experiment, in Langfuse
	PassRate float64
	Err      error
}

// Scored is one case in one run.
type Scored struct {
	Passed  bool
	Scores  map[string]float64
	Reasons map[string]string
	TraceID string
	Answer  string // the subject's answer, in JSON; empty when the play failed
}

// Run syncs the cases into Langfuse, then plays the dataset opt.Runs times in
// parallel. Each pass is an experiment of its own: Langfuse compares them.
func Run(ctx context.Context, s *Subject, lf *Langfuse, cases []Case, opt Options) (*Report, error) {
	start := time.Now()
	if len(cases) == 0 {
		return nil, errors.New("no case")
	}
	opt.Runs = max(opt.Runs, 1)
	if opt.Name == "" {
		opt.Name = s.Variant + " · " + time.Now().Format("02/01 15:04")
	}
	d, _, err := lf.Sync(ctx, s.Name, s.Description, cases)
	if err != nil {
		return nil, fmt.Errorf("langfuse: %w", err)
	}
	rep := &Report{Dataset: d, Scores: map[string][]Scored{}, Thresholds: map[string]float64{}}
	for _, c := range cases {
		rep.Cases = append(rep.Cases, c.ID)
		rep.Scores[c.ID] = make([]Scored, opt.Runs)
	}
	for _, m := range s.Metrics {
		rep.Metrics = append(rep.Metrics, m.Name)
		rep.Thresholds[m.Name] = m.Threshold
	}
	rep.Runs = make([]RunResult, opt.Runs)

	var wg sync.WaitGroup
	for k := range opt.Runs {
		wg.Go(func() {
			name := opt.Name
			if opt.Runs > 1 {
				name = fmt.Sprintf("%s #%d", opt.Name, k+1)
			}
			rep.Runs[k] = RunResult{Name: name}
			out, err := pass(ctx, s, lf, d, cases, name, opt.Description)
			if err != nil {
				rep.Runs[k].Err = err
				return
			}
			rep.Runs[k].ID = out.experiment
			rep.Runs[k].PassRate = out.passRate
			for _, c := range out.cases {
				id := strings.TrimPrefix(c.itemID, s.Name+":")
				if _, ok := rep.Scores[id]; ok {
					rep.Scores[id][k] = Scored{Passed: c.status == status.EvalStatusPassed,
						Scores: c.scores, Reasons: c.reasons, TraceID: c.traceID, Answer: c.answer}
				}
			}
		})
	}
	wg.Wait()
	rep.Cost = s.Stats.Cost()
	rep.Duration = time.Since(start)
	return rep, nil
}

// passed is one pass, as the report reads it.
type passed struct {
	experiment string
	passRate   float64
	cases      []caseOut
}

type caseOut struct {
	itemID  string
	traceID string
	answer  string
	status  status.EvalStatus
	scores  map[string]float64
	reasons map[string]string
}

// caseParallelism bounds the cases a pass plays at once: passes run side by
// side too, and OpenRouter has a rate.
const caseParallelism = 3

// pass is one experiment over the dataset, written the Langfuse v4 way.
// trpc-agent-go's evaluation plays each case with the subject's engines and
// scores it with our checks; the case runs under a root span carrying the
// langfuse.experiment.* attributes, which is what makes it an experiment
// item in v4 (the dataset-run API of v3, which trpc-agent-go's Langfuse
// handler uses, is refused by a v4 deployment). The scores go through the
// public API, which v4 keeps.
func pass(ctx context.Context, s *Subject, lf *Langfuse, d Dataset, cases []Case, name, desc string) (*passed, error) {
	sets, results := evalsetinmemory.New(), evalresultinmemory.New()
	reg := registry.New()
	for _, m := range s.Metrics {
		if err := reg.Register(m.Name, evaluatorFor(m)); err != nil {
			return nil, err
		}
	}
	if _, err := sets.Create(ctx, appName, d.ID); err != nil {
		return nil, err
	}
	for _, c := range cases {
		ec, err := evalCase(s, c)
		if err != nil {
			return nil, fmt.Errorf("case %s: %w", c.ID, err)
		}
		if err := sets.AddCase(ctx, appName, d.ID, ec); err != nil {
			return nil, err
		}
	}
	ev, err := evaluation.New(appName, runner.NewRunner(appName, player{s}),
		evaluation.WithEvalSetManager(sets),
		evaluation.WithMetricManager(fixedMetrics(s.Metrics)),
		evaluation.WithEvalResultManager(results),
		evaluation.WithRegistry(reg),
		evaluation.WithRunDetailsEnabled(true),
	)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := ev.Close(); err != nil {
			log.Printf("bench: closing the evaluation of %s: %v", name, err)
		}
	}()

	out := &passed{experiment: rand.Text()}
	outs := make([]caseOut, len(cases))
	sem := make(chan struct{}, caseParallelism)
	var wg sync.WaitGroup
	for i, c := range cases {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			outs[i] = playCase(ctx, ev, s, lf, d, c, out.experiment, name, desc)
		})
	}
	wg.Wait()
	if err := flush(ctx); err != nil {
		return nil, fmt.Errorf("sending the traces: %w", err)
	}
	ok := 0
	for _, c := range outs {
		if c.status == status.EvalStatusPassed {
			ok++
		}
	}
	out.cases = outs
	out.passRate = float64(ok) / float64(len(cases))
	// a score Langfuse did not take is reported, not fatal: the pass is paid
	// for and its results stand without it
	if err := lf.Score(ctx, Score{Name: "pass_rate", Value: out.passRate, DatasetRunID: out.experiment,
		Comment: fmt.Sprintf("%d/%d cases passed", ok, len(cases))}); err != nil {
		log.Printf("langfuse: score pass_rate of %s not sent: %v", name, err)
	}
	return out, nil
}

// evalCase is a case as the evaluation plays it: the input in the session
// state, for the player, and the whole case as the reference the metrics
// read.
func evalCase(s *Subject, c Case) (*evalset.EvalCase, error) {
	ref, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	return &evalset.EvalCase{
		EvalID: itemID(s.Name, c.ID),
		Conversation: []*evalset.Invocation{{
			UserContent:   &model.Message{Role: model.RoleUser, Content: "case " + c.ID},
			FinalResponse: &model.Message{Role: model.RoleAssistant, Content: string(ref)},
		}},
		SessionInput: &evalset.SessionInput{AppName: appName, UserID: "bench", State: map[string]any{stateKey: string(c.Input)}},
	}, nil
}

// playCase runs one case under the root span of its experiment item, then
// writes its scores on the trace.
func playCase(ctx context.Context, ev evaluation.AgentEvaluator, s *Subject, lf *Langfuse, d Dataset,
	c Case, experiment, name, desc string) caseOut {
	id := itemID(s.Name, c.ID)
	ctx, span := atrace.Tracer.Start(ctx, "bench "+s.Name+" · "+c.ID, oteltrace.WithNewRoot())
	root := span.SpanContext()
	attrs := []attribute.KeyValue{
		attribute.String("langfuse.trace.name", s.Name+" · "+c.ID),
		attribute.String("langfuse.environment", "bench"),
		attribute.StringSlice("langfuse.trace.tags", append([]string{"bench", s.Name}, c.Tags...)),
		attribute.String("langfuse.version", s.Variant),
		attribute.String("langfuse.user.id", "bench"),
		attribute.String("langfuse.trace.input", string(c.Input)),
		attribute.String("langfuse.observation.input", string(c.Input)),
		attribute.String("langfuse.experiment.id", experiment),
		attribute.String("langfuse.experiment.name", name),
		attribute.String("langfuse.experiment.dataset.id", d.ID),
		attribute.String("langfuse.experiment.item.id", id),
		attribute.String("langfuse.experiment.item.root_observation_id", root.SpanID().String()),
		attribute.String("langfuse.experiment.item.expected_output", string(c.Expect)),
		attribute.String("langfuse.experiment.metadata.variant", s.Variant),
		attribute.String("langfuse.experiment.item.metadata.note", c.Note),
	}
	if desc != "" {
		attrs = append(attrs, attribute.String("langfuse.experiment.description", desc))
	}
	span.SetAttributes(attrs...)

	res, err := ev.Evaluate(ctx, d.ID, evaluation.WithEvalCaseIDs(id), evaluation.WithRunDetailsEnabled(true))
	out := caseOut{itemID: id, traceID: root.TraceID().String(), status: status.EvalStatusFailed,
		scores: map[string]float64{}, reasons: map[string]string{}}
	if err != nil {
		span.SetAttributes(attribute.String("langfuse.observation.level", "ERROR"),
			attribute.String("langfuse.observation.status_message", err.Error()))
		span.End()
		out.reasons["error"] = err.Error()
		return out
	}
	for _, ec := range res.EvalCases {
		if ec == nil || ec.EvalCaseID != id {
			continue
		}
		out.status = ec.OverallStatus
		for _, rd := range ec.RunDetails {
			if rd == nil || rd.Inference == nil || len(rd.Inference.Inferences) == 0 {
				continue
			}
			if last := rd.Inference.Inferences[len(rd.Inference.Inferences)-1]; last != nil && last.FinalResponse != nil {
				out.answer = last.FinalResponse.Content
				span.SetAttributes(attribute.String("langfuse.trace.output", last.FinalResponse.Content),
					attribute.String("langfuse.observation.output", last.FinalResponse.Content))
			}
		}
		for _, m := range ec.MetricResults {
			if m == nil {
				continue
			}
			// a metric that could not be scored has no score: a 0 would read
			// as a failure of the engines, a 1 as a pass
			if m.EvalStatus != status.EvalStatusNotEvaluated {
				out.scores[m.MetricName] = m.Score
			}
			if m.Details != nil && m.Details.Reason != "" {
				out.reasons[m.MetricName] = m.Details.Reason
			}
		}
	}
	// the per-case reasons live on the per-run results
	if res.EvalResult != nil {
		for _, cr := range res.EvalResult.EvalCaseResults {
			if cr == nil || cr.EvalID != id {
				continue
			}
			// a play that failed, or an evaluator's error, fails the whole
			// case in trpc-agent-go, its metrics dropped: the message is all
			// that is left of it
			if cr.ErrorMessage != "" {
				out.reasons["error"] = cr.ErrorMessage
			}
			for _, m := range cr.OverallEvalMetricResults {
				if m != nil && m.Details != nil && m.Details.Reason != "" {
					out.reasons[m.MetricName] = m.Details.Reason
				}
			}
		}
	}
	span.End()
	for _, m := range s.Metrics {
		v, ok := out.scores[m.Name]
		if !ok {
			continue
		}
		if err := lf.Score(ctx, Score{Name: m.Name, Value: v, TraceID: out.traceID, Comment: out.reasons[m.Name]}); err != nil {
			log.Printf("langfuse: score %s of %s not sent: %v", m.Name, c.ID, err)
		}
	}
	return out
}

// flush sends the spans still buffered: the scores point at traces, and the
// report at pages, that must exist when the command returns.
func flush(ctx context.Context) error {
	p, ok := atrace.TracerProvider.(*sdktrace.TracerProvider)
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return p.ForceFlush(ctx)
}

// checkEvaluator is one of our checks in code, as trpc-agent-go calls an
// evaluator: the actual answer against the case, invocation by invocation.
type checkEvaluator struct{ m Metric }

func (e checkEvaluator) Name() string        { return e.m.Name }
func (e checkEvaluator) Description() string { return "delorean: " + e.m.Name }

func (e checkEvaluator) Evaluate(_ context.Context, actuals, expecteds []*evalset.Invocation,
	em *metric.EvalMetric) (*evaluator.EvaluateResult, error) {
	res := &evaluator.EvaluateResult{OverallStatus: status.EvalStatusFailed}
	total := 0.0
	for i, act := range actuals {
		exp := at(expecteds, i)
		score, reason := 0.0, "no answer"
		if c, err := reference(exp); err != nil {
			reason = err.Error()
		} else if act != nil && act.FinalResponse != nil {
			score, reason = e.m.Check(act.FinalResponse.Content, c)
		}
		total += score
		res.PerInvocationResults = append(res.PerInvocationResults, &evaluator.PerInvocationResult{
			ActualInvocation: act, ExpectedInvocation: exp, Score: score, Status: verdict(score, em.Threshold),
			Details: &evaluator.PerInvocationDetails{Reason: reason, Score: score},
		})
	}
	if len(actuals) == 0 {
		return res, nil
	}
	res.OverallScore = total / float64(len(actuals))
	res.OverallStatus = verdict(res.OverallScore, em.Threshold)
	return res, nil
}

// probeEvaluator asks a model to score each invocation.
type probeEvaluator struct{ m Metric }

func (e probeEvaluator) Name() string        { return e.m.Name }
func (e probeEvaluator) Description() string { return "delorean, asked of a model: " + e.m.Name }

func (e probeEvaluator) Evaluate(ctx context.Context, actuals, expecteds []*evalset.Invocation,
	em *metric.EvalMetric) (*evaluator.EvaluateResult, error) {
	res := &evaluator.EvaluateResult{OverallStatus: status.EvalStatusFailed}
	total, scored := 0.0, 0
	for i, act := range actuals {
		exp := at(expecteds, i)
		score, reason := 0.0, "no answer"
		if c, err := reference(exp); err != nil {
			reason = err.Error()
		} else if act != nil && act.FinalResponse != nil {
			score, reason, err = e.m.Probe(ctx, act.FinalResponse.Content, c)
			if err != nil {
				// a model out of reach is no verdict on the answer. An error
				// here would fail the whole case in trpc-agent-go and drop the
				// checks that did run: the metric is left unscored instead,
				// and says why.
				res.PerInvocationResults = append(res.PerInvocationResults, &evaluator.PerInvocationResult{
					ActualInvocation: act, ExpectedInvocation: exp, Status: status.EvalStatusNotEvaluated,
					Details: &evaluator.PerInvocationDetails{Reason: "not evaluated, the model is out of reach: " + err.Error()},
				})
				continue
			}
		}
		total += score
		scored++
		res.PerInvocationResults = append(res.PerInvocationResults, &evaluator.PerInvocationResult{
			ActualInvocation: act, ExpectedInvocation: exp, Score: score, Status: verdict(score, em.Threshold),
			Details: &evaluator.PerInvocationDetails{Reason: reason, Score: score},
		})
	}
	switch {
	case scored == 0 && len(actuals) > 0:
		res.OverallStatus = status.EvalStatusNotEvaluated
	case scored > 0:
		res.OverallScore = total / float64(scored)
		res.OverallStatus = verdict(res.OverallScore, em.Threshold)
	}
	return res, nil
}

// evaluatorFor is the evaluator trpc-agent-go calls for a metric.
func evaluatorFor(m Metric) evaluator.Evaluator {
	if m.Probe != nil {
		return probeEvaluator{m}
	}
	return checkEvaluator{m}
}

func at(invs []*evalset.Invocation, i int) *evalset.Invocation {
	if i < len(invs) {
		return invs[i]
	}
	return nil
}

// reference is the case an expected invocation carries (evalCase).
func reference(exp *evalset.Invocation) (Case, error) {
	var c Case
	if exp == nil || exp.FinalResponse == nil {
		return c, errors.New("no case to compare with")
	}
	if err := json.Unmarshal([]byte(exp.FinalResponse.Content), &c); err != nil {
		return c, fmt.Errorf("case unreadable: %w", err)
	}
	return c, nil
}

func verdict(score, threshold float64) status.EvalStatus {
	if score >= threshold {
		return status.EvalStatusPassed
	}
	return status.EvalStatusFailed
}

// fixedMetrics serves the subject's metrics whatever the eval set: eval sets
// are named after Langfuse dataset ids, and every set of a subject is scored
// the same way.
type fixedMetrics []Metric

func (f fixedMetrics) List(context.Context, string, string) ([]string, error) {
	out := make([]string, 0, len(f))
	for _, m := range f {
		out = append(out, m.Name)
	}
	return out, nil
}

func (f fixedMetrics) Get(_ context.Context, _, _, name string) (*metric.EvalMetric, error) {
	for _, m := range f {
		if m.Name == name {
			return &metric.EvalMetric{MetricName: m.Name, EvaluatorName: m.Name, Threshold: m.Threshold}, nil
		}
	}
	return nil, fmt.Errorf("metric %s unknown", name)
}

func (fixedMetrics) Add(context.Context, string, string, *metric.EvalMetric) error    { return nil }
func (fixedMetrics) Delete(context.Context, string, string, string) error             { return nil }
func (fixedMetrics) Update(context.Context, string, string, *metric.EvalMetric) error { return nil }
func (fixedMetrics) Close() error                                                     { return nil }

// Unscored lists the metrics that could not be scored, run by run, and why:
// a case can pass without them, and that must show.
func (r *Report) Unscored() []string {
	var out []string
	for _, id := range r.Cases {
		for k, sc := range r.Scores[id] {
			if sc.Scores == nil {
				continue
			}
			for _, m := range r.Metrics {
				if _, ok := sc.Scores[m]; !ok {
					out = append(out, fmt.Sprintf("%s, run %d — %s: %s", id, k+1, m, sc.Reasons[m]))
				}
			}
		}
	}
	return out
}

// MinConfidence is the lowest confidence the engine gave a case across the
// runs, for the subjects whose answer carries one (guard, identify); false
// when no answer of the case does.
func (r *Report) MinConfidence(id string) (float64, bool) {
	low, ok := 0.0, false
	for _, sc := range r.Scores[id] {
		var a struct {
			Confidence *float64 `json:"confidence"`
		}
		if json.Unmarshal([]byte(sc.Answer), &a) != nil || a.Confidence == nil {
			continue
		}
		if !ok || *a.Confidence < low {
			low, ok = *a.Confidence, true
		}
	}
	return low, ok
}

// Failed lists, for each case, the runs it failed and why — what the terminal
// shows before anyone opens Langfuse.
func (r *Report) Failed() []string {
	var out []string
	for _, id := range r.Cases {
		for k, sc := range r.Scores[id] {
			if sc.Scores == nil || sc.Passed {
				continue
			}
			var why []string
			names := make([]string, 0, len(sc.Scores))
			for n := range sc.Scores {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				if sc.Reasons[n] != "" && sc.Scores[n] < r.Thresholds[n] {
					why = append(why, fmt.Sprintf("%s %.2f: %s", n, sc.Scores[n], sc.Reasons[n]))
				}
			}
			// a case the evaluation could not play has no score, only its error
			if e := sc.Reasons["error"]; e != "" && len(why) == 0 {
				why = append(why, "error: "+e)
			}
			out = append(out, fmt.Sprintf("%s, run %d — %s", id, k+1, strings.Join(why, " · ")))
		}
	}
	return out
}
