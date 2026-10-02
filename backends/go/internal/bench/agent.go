package bench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"trpc.group/trpc-go/trpc-agent-go/agent"
	"trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/tool"

	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// stateKey carries a case's input to the player through the session state.
const stateKey = "case_input"

// player makes a subject a trpc-agent-go agent, so the evaluation module
// plays it like any other: its runner, its traces. It is not a chat agent —
// the case's input comes in through the session state, the subject's answer
// goes out as the final message, in JSON.
type player struct{ s *Subject }

func (p player) Run(ctx context.Context, inv *agent.Invocation) (<-chan *event.Event, error) {
	raw, _ := inv.RunOptions.RuntimeState[stateKey].(string)
	if raw == "" {
		return nil, errors.New("bench: the invocation carries no case")
	}
	out := make(chan *event.Event, 1)
	go func() {
		defer close(out)
		start := time.Now()
		answer, usage, err := p.s.Play(ctx, json.RawMessage(raw))
		p.s.Stats.played(time.Since(start), usage, err)
		var b []byte
		if err == nil {
			b, err = json.Marshal(answer)
		}
		rsp := &model.Response{Object: model.ObjectTypeChatCompletion, Done: true}
		if err != nil {
			rsp.Error = &model.ResponseError{Message: err.Error(), Type: model.ErrorTypeAPIError}
		} else {
			rsp.Choices = []model.Choice{{Message: model.NewAssistantMessage(string(b))}}
		}
		out <- event.NewResponseEvent(inv.InvocationID, p.s.Name, rsp)
	}()
	return out, nil
}

func (p player) Tools() []tool.Tool { return nil }
func (p player) Info() agent.Info {
	return agent.Info{Name: p.s.Name, Description: p.s.Description}
}
func (p player) SubAgents() []agent.Agent        { return nil }
func (p player) FindSubAgent(string) agent.Agent { return nil }

// Stats counts what a bench took: how long each play lasted — the latency
// is half of what separates two engines — what the plays and the probes
// cost, and how many plays failed.
type Stats struct {
	mu     sync.Mutex
	ms     []int64
	calls  int
	plays  float64 // USD
	probes float64 // USD
	failed int
}

func (s *Stats) played(d time.Duration, usage []pipeline.Usage, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range usage {
		s.calls += u.Calls
		s.plays += u.CostUSD
	}
	if err != nil {
		s.failed++
		return
	}
	s.ms = append(s.ms, d.Milliseconds())
}

func (s *Stats) probed(usd float64) {
	s.mu.Lock()
	s.probes += usd
	s.mu.Unlock()
}

// Cost is what the bench has spent so far, plays and probes.
func (s *Stats) Cost() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.plays + s.probes
}

// String is one line for the report: plays, latency, model calls, cost.
func (s *Stats) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.ms) == 0 {
		return fmt.Sprintf("no play answered (%d failed)", s.failed)
	}
	ms := slices.Clone(s.ms)
	slices.Sort(ms)
	line := fmt.Sprintf("%d plays · median %d ms · p90 %d ms · max %d ms · %d model calls · %.5f USD",
		len(ms), ms[len(ms)/2], ms[len(ms)*9/10], ms[len(ms)-1], s.calls, s.plays)
	if s.probes > 0 {
		line += fmt.Sprintf(" + judge %.5f USD", s.probes)
	}
	return line + fmt.Sprintf(" · %d failed", s.failed)
}
