package live

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/cart"
)

// Each title is its own request, all in parallel; the answers come back in
// the order of the titles whichever request answers first, with the cost of
// all of them.
func TestIdentifierAsksEachTitleApart(t *testing.T) {
	films := map[string]cart.Film{
		"Retour vers le futur":      cart.BTTF1,
		"Zurück in die Zukunft II":  cart.BTTF2,
		"Back to the Future Part 3": cart.BTTF3,
		"La chèvre":                 cart.Other,
	}
	jev, seen := jevServer(t, func(a asked) (int, string) {
		title, _ := a.State["film_title"].(string)
		f, ok := films[title]
		if !ok {
			return 400, `{"error":{"message":"unknown title"}}`
		}
		time.Sleep(time.Duration(len(title)) * time.Millisecond) // the longest title answers last
		return 200, fmt.Sprintf(`{"answers":{"film":{"choice":%q,"confidence":0.9,"probabilities":{%q:0.9}}},"usage":{"cost":0.00002}}`, f, f)
	})
	titles := []string{"Back to the Future Part 3", "La chèvre", "Retour vers le futur", "Zurück in die Zukunft II"}
	ids, u, err := Identifier{Jev: jev}.Identify(context.Background(), titles)
	if err != nil {
		t.Fatal(err)
	}
	for i, title := range titles {
		if ids[i].Film != films[title] || ids[i].Confidence != 0.9 || ids[i].Probabilities[films[title]] != 0.9 {
			t.Errorf("%s: %+v", title, ids[i])
		}
	}
	if u.Calls != len(titles) || u.CostUSD < 0.0000799 || u.CostUSD > 0.0000801 {
		t.Errorf("usage %+v", u)
	}
	for _, a := range seen() {
		key, q := a.question(t)
		criteria, _ := q["criteria"].(map[string]any)
		if key != "film" || q["type"] != "choice" || len(criteria) != len(cart.Films) || len(a.State) != 1 {
			t.Errorf("request %+v", a)
		}
	}
}

// One title Jev cannot answer fails the identification as a whole.
func TestIdentifierFailsWithOneTitle(t *testing.T) {
	jev, _ := jevServer(t, func(a asked) (int, string) {
		if strings.Contains(a.State["film_title"].(string), "Ride") {
			return 529, `{"error":{"message":"overloaded"}}`
		}
		return 200, `{"answers":{"film":{"choice":"other","confidence":0.8}}}`
	})
	ids, _, err := Identifier{Jev: jev}.Identify(context.Background(), []string{"La chèvre", "Back to the Future: The Ride"})
	if ids != nil {
		t.Errorf("identifications %+v", ids)
	}
	isEngineErr(t, err)
}
