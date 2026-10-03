// Package decide puts typed questions about a text to a System One model —
// one that answers with calibrated probabilities, never prose — and is the
// only road to such a model in delorean.
//
// The engine is Jev (TypeSafe), hosted, reached through OpenRouter's
// decisions endpoint, behind the Decider interface.
//
// A question is the whole prompt: its instructions and the description of
// each option. Quality is tuned there, by whoever owns the question — the
// live engines — never here.
package decide

import (
	"context"
	"fmt"
)

// Kind is the type of a question, as Jev names it.
type Kind string

const (
	// Noul is a yes/no question answered by the probability of "yes".
	Noul Kind = "noul"
	// Choice picks one of the keys of Criteria.
	Choice Kind = "choice"
)

// Question is one question put about a state, in the JSON of the
// repository's prompts/ files.
type Question struct {
	Key          string `json:"key"`
	Kind         Kind   `json:"kind"`
	Instructions string `json:"instructions"`
	// Criteria describes each option: the keys of a choice, "true" and
	// "false" for a noul.
	Criteria map[string]string `json:"criteria"`
}

// YesNo is a noul question.
func YesNo(key, instructions, yes, no string) Question {
	return Question{Key: key, Kind: Noul, Instructions: instructions,
		Criteria: map[string]string{"true": yes, "false": no}}
}

// Request is one call: every key of State is a document the model reads,
// named for what it is. Questions put in one request are answered together —
// and colour one another: put independent judgements in separate requests.
type Request struct {
	State     map[string]any
	Questions []Question
}

// Answer is one question's answer. Noul is set for a noul question, Choice
// and Probabilities for a choice.
type Answer struct {
	Noul          float64            `json:"noul,omitempty"`
	Choice        string             `json:"choice,omitempty"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
}

// Decision is every answer of one request, and what it took.
type Decision struct {
	Answers map[string]Answer `json:"answers"`
	Cost    float64           `json:"cost"`   // USD as the engine reports it
	ID      string            `json:"id"`     // the upstream decision id, for audit
	Ms      int64             `json:"ms"`     // wall time of the call, retries included
	Engine  string            `json:"engine"` // which engine answered: "jev-1.13"
	Model   string            `json:"model"`  // the model id asked: "typesafe/jev-1.13"
	// InputTokens and OutputTokens are the tokens as the engine reports
	// them; 0 when it reports none.
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Decider answers requests. *HTTP is the real one; tests use their own.
type Decider interface {
	Decide(ctx context.Context, r Request) (Decision, error)
	// Engine names the engine and its version, for usage, traces and benches.
	Engine() string
}

// wire is a question as Jev reads it.
func (q Question) wire() map[string]any {
	return map[string]any{"type": string(q.Kind), "instructions": q.Instructions, "criteria": q.Criteria}
}

// check refuses an answer the question could not have: a missing one, a
// choice outside its options, a probability outside [0, 1]. An engine that
// drifts is an error, not a verdict.
func check(r Request, d Decision) error {
	for _, q := range r.Questions {
		a, ok := d.Answers[q.Key]
		if !ok {
			return fmt.Errorf("%s: no answer for %q", d.Engine, q.Key)
		}
		if q.Kind == Choice {
			if _, ok := q.Criteria[a.Choice]; !ok {
				return fmt.Errorf("%s: %q answered %q, not one of its options", d.Engine, q.Key, a.Choice)
			}
		}
		if !unit(a.Noul) || !unit(a.Confidence) {
			return fmt.Errorf("%s: %q answered a probability outside [0, 1]", d.Engine, q.Key)
		}
	}
	return nil
}

func unit(p float64) bool { return p >= 0 && p <= 1 }
