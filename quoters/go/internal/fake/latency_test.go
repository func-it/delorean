package fake

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// The delays every quoter computes for the same calls (docs/architecture.md,
// "Fake engines"): the vectors are written there too.
func TestDelayVectors(t *testing.T) {
	for _, tc := range []struct {
		stage pipeline.Stage
		input string
		ms    int64
	}{
		{pipeline.StageGuard, "Heat", 385},
		{pipeline.StageParse, "Back to the Future 1\nHeat", 1186},
		{pipeline.StageRecount, "Back to the Future 1\nHeat", 2770},
		{pipeline.StageIdentify, "Heat", 316},
		{pipeline.StageJudge, "", 377},
	} {
		if got := Delay(tc.stage, tc.input).Milliseconds(); got != tc.ms {
			t.Errorf("Delay(%s, %q) = %d ms, want %d", tc.stage, tc.input, got, tc.ms)
		}
	}
}

// Every delay stays within 20 % of its stage's profile.
func TestDelayJitter(t *testing.T) {
	for s, base := range Profile {
		for i := range 500 {
			d := Delay(s, string(rune('a'+i%26))+time.Duration(i).String())
			if d < base*4/5 || d >= base*6/5 {
				t.Fatalf("%s: %v outside 80–120 %% of %v", s, d, base)
			}
		}
	}
}

// With Real, a call takes its delay, and the request's end cuts it short;
// off, it takes nothing; FAKE_CPU_MS keeps the processor busy that long.
func TestLatencyTake(t *testing.T) {
	start := time.Now()
	if _, _, err := (Identifier{Latency{Real: true}}).Identify(context.Background(), []string{"Heat"}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took < 316*time.Millisecond || took > time.Second {
		t.Errorf("identify took %v, want 316 ms", took)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := (Recounter{Latency{Real: true}}).Parse(ctx, "Heat", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want the deadline", err)
	}
	start = time.Now()
	if _, _, err := (Guard{}).Check(context.Background(), "Heat"); err != nil || time.Since(start) > 50*time.Millisecond {
		t.Errorf("off: %v, %v", err, time.Since(start))
	}
	start = time.Now()
	if _, _, err := (Judge{Latency{CPUMs: 30}}).Judge(context.Background(), "Heat", nil); err != nil || time.Since(start) < 30*time.Millisecond {
		t.Errorf("cpu: %v, %v", err, time.Since(start))
	}
}
