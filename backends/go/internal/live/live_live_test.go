package live

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// TestLiveReadsACart reads one cart through every live engine, on the real
// models: RUN_LIVE=1 and OPENROUTER_API_KEY, from backends/go. A smoke test
// of the wiring, about a cent; the benches (cmd/bench) measure the quality.
func TestLiveReadsACart(t *testing.T) {
	key := os.Getenv("OPENROUTER_API_KEY")
	if os.Getenv("RUN_LIVE") != "1" || key == "" {
		t.Skip("RUN_LIVE=1 and OPENROUTER_API_KEY call the real models")
	}
	e, err := New(Config{OpenRouterKey: key, ParseModel: os.Getenv("PARSE_MODEL"),
		ParseEffort: os.Getenv("PARSE_EFFORT"), JevModel: os.Getenv("JEV_MODEL")})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	text := "Bonjour ! Retour vers le futur 2 en deux exemplaires, et La chèvre."

	v, u, err := e.Guard.Check(ctx, text)
	if err != nil || v.Verdict != pipeline.Valid {
		t.Fatalf("guard: %+v, %v", v, err)
	}
	t.Logf("guard %s %.2f · %d ms · %.5f USD", v.Verdict, v.Confidence, u.Ms, u.CostUSD)

	mentions, u, err := e.Parser.Parse(ctx, text)
	if err != nil || len(mentions) != 2 {
		t.Fatalf("parse: %+v, %v", mentions, err)
	}
	t.Logf("parse %+v · %d ms · %.5f USD", mentions, u.Ms, u.CostUSD)

	titles := []string{mentions[0].Title, mentions[1].Title}
	ids, u, err := e.Identifier.Identify(ctx, titles)
	if err != nil || ids[0].Film != cart.BTTF2 || ids[1].Film != cart.Other {
		t.Fatalf("identify %v: %+v, %v", titles, ids, err)
	}
	t.Logf("identify %s %s · %d ms · %.5f USD", ids[0].Film, ids[1].Film, u.Ms, u.CostUSD)

	lines := []cart.Line{
		{Title: mentions[0].Title, Quantity: mentions[0].Quantity, Film: ids[0].Film},
		{Title: mentions[1].Title, Quantity: mentions[1].Quantity, Film: ids[1].Film},
	}
	j, u, err := e.Judge.Judge(ctx, text, lines)
	if err != nil || j.Score < 0.5 {
		t.Fatalf("judge: %+v, %v", j, err)
	}
	t.Logf("judge %.2f %+v · %d ms · %.5f USD", j.Score, j.Findings, u.Ms, u.CostUSD)
}
