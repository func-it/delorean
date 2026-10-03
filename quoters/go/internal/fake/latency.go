package fake

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"runtime"
	"strings"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Latency makes the fakes take time, as models do, for the load bench
// (docs/architecture.md, "Fake engines"): the same in every quoter. Its zero
// value takes none, as the suites want.
type Latency struct {
	// Real waits, without holding a thread, for the stage's time of
	// Profile, give or take 20 %: FAKE_LATENCY=real.
	Real bool
	// CPUMs keeps a processor busy that long on each call, before the
	// wait: FAKE_CPU_MS.
	CPUMs int
}

// Profile is how long each fake call takes with Real, close to the live
// engines' measures.
var Profile = map[pipeline.Stage]time.Duration{
	pipeline.StageGuard:    400 * time.Millisecond,
	pipeline.StageParse:    1200 * time.Millisecond,
	pipeline.StageRecount:  2500 * time.Millisecond,
	pipeline.StageIdentify: 300 * time.Millisecond,
	pipeline.StageJudge:    350 * time.Millisecond,
}

// Delay is the time of the call of stage s that reads input: its profile,
// from 80 % to 120 %, by the first 4 bytes of SHA-256(stage "\n" input) read
// as a big-endian n: base × 4/5 + ⌊base × 2n / (5 × 2³²)⌋ milliseconds. The
// same call takes the same time in every quoter and every run.
func Delay(s pipeline.Stage, input string) time.Duration {
	base := uint64(Profile[s].Milliseconds())
	sum := sha256.Sum256([]byte(string(s) + "\n" + input))
	n := uint64(binary.BigEndian.Uint32(sum[:4]))
	return time.Duration(base*4/5+base*2*n/(5<<32)) * time.Millisecond
}

// take is one fake call of stage s on input: the CPU loop, then the wait,
// which the request's end cuts short.
func (l Latency) take(ctx context.Context, s pipeline.Stage, input string) error {
	if l.CPUMs > 0 {
		spin(time.Duration(l.CPUMs) * time.Millisecond)
	}
	if !l.Real {
		return nil
	}
	t := time.NewTimer(Delay(s, input))
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// spin keeps the processor busy for d: work a model's client would do,
// parsing and validating, made heavy on purpose.
func spin(d time.Duration) {
	start := time.Now()
	x := uint64(1)
	for time.Since(start) < d {
		for range 1000 {
			x = x*6364136223846793005 + 1442695040888963407
		}
	}
	runtime.KeepAlive(x) // the loop's work is kept
}

// titlesInput is what identify reads, for Delay: the titles, one per line.
func titlesInput(titles []string) string { return strings.Join(titles, "\n") }
