package httpapi

import (
	"encoding/json"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// quoteCase is a case of cases/quote (docs/architecture.md, "Cas partagés").
type quoteCase struct {
	ID    string   `json:"id"`
	Note  string   `json:"note"`
	Tags  []string `json:"tags"`
	Input struct {
		Cart string `json:"cart"`
	} `json:"input"`
	Expect struct {
		Status     int            `json:"status"`
		TotalCents *int           `json:"total_cents"`
		Films      map[string]int `json:"films"`
		Code       ProblemCode    `json:"code"`
	} `json:"expect"`
}

// TestQuoteCases plays every shared case the fake engines must pass through
// the handler, as the end-to-end suite plays them against a running server.
func TestQuoteCases(t *testing.T) {
	paths, err := filepath.Glob("../../../../cases/quote/*.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("no case in cases/quote")
	}
	h := newServer(t, nil)
	for _, path := range paths {
		c := readCase(t, path)
		if !slices.Contains(c.Tags, "fake") {
			continue
		}
		t.Run(c.ID, func(t *testing.T) {
			rec := postCart(t, h, c.Input.Cart)
			if rec.Code != c.Expect.Status {
				t.Fatalf("status = %d, want %d (%s)\n%s", rec.Code, c.Expect.Status, c.Note, rec.Body)
			}
			if rec.Code != http.StatusOK {
				problemOf(t, rec, c.Expect.Status, c.Expect.Code)
				return
			}
			conforms(t, rec, "Quote", "application/json")
			var q Quote
			if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil {
				t.Fatal(err)
			}
			if c.Expect.TotalCents != nil && q.TotalCents != *c.Expect.TotalCents {
				t.Errorf("total = %d, want %d (%s)", q.TotalCents, *c.Expect.TotalCents, c.Note)
			}
			if c.Expect.Films != nil {
				films := map[string]int{}
				for _, l := range q.Lines {
					films[string(l.Film)] += l.Quantity
				}
				if !maps.Equal(films, c.Expect.Films) {
					t.Errorf("films = %v, want %v (%s)", films, c.Expect.Films, c.Note)
				}
			}
		})
	}
}

func readCase(t *testing.T, path string) quoteCase {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var c quoteCase
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	if id := strings.TrimSuffix(filepath.Base(path), ".json"); c.ID != id {
		t.Errorf("%s: id %q, the file name says %q", path, c.ID, id)
	}
	return c
}
