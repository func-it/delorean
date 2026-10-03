package pricing

import (
	"testing"

	"github.com/func-it/delorean/quoters/go/internal/cart"
)

func line(title string, quantity int, film cart.Film) cart.Line {
	return cart.Line{Title: title, Quantity: quantity, Film: film, Confidence: 1}
}

func TestPrice(t *testing.T) {
	var (
		bttf1  = line("Back to the Future 1", 1, cart.BTTF1)
		bttf2  = line("Back to the Future 2", 1, cart.BTTF2)
		bttf3  = line("Back to the Future 3", 1, cart.BTTF3)
		chevre = line("La chèvre", 1, cart.Other)
	)
	tests := []struct {
		name     string
		lines    []cart.Line
		subtotal int
		discount Discount
		total    int
	}{
		{
			name:     "brief 1: the three volumes, 20 %",
			lines:    []cart.Line{bttf1, bttf2, bttf3},
			subtotal: 4500,
			discount: Discount{DistinctVolumes: 3, Percent: 20, BaseCents: 4500, AmountCents: 900},
			total:    3600,
		},
		{
			name:     "brief 2: two volumes, 10 %",
			lines:    []cart.Line{bttf1, bttf3},
			subtotal: 3000,
			discount: Discount{DistinctVolumes: 2, Percent: 10, BaseCents: 3000, AmountCents: 300},
			total:    2700,
		},
		{
			name:     "brief 3: one volume, no discount",
			lines:    []cart.Line{bttf1},
			subtotal: 1500,
			discount: Discount{DistinctVolumes: 1, BaseCents: 1500},
			total:    1500,
		},
		{
			name:     "brief 4: a second copy is in the base, not among the distinct volumes",
			lines:    []cart.Line{bttf1, bttf2, bttf3, bttf2},
			subtotal: 6000,
			discount: Discount{DistinctVolumes: 3, Percent: 20, BaseCents: 6000, AmountCents: 1200},
			total:    4800,
		},
		{
			name:     "brief 5: another film is full price, out of the base",
			lines:    []cart.Line{bttf1, bttf2, bttf3, chevre},
			subtotal: 6500,
			discount: Discount{DistinctVolumes: 3, Percent: 20, BaseCents: 4500, AmountCents: 900},
			total:    5600,
		},
		{
			name: "two titles of one volume count once",
			lines: []cart.Line{
				line("BTTF 2", 1, cart.BTTF2),
				line("Retour vers le futur 2", 1, cart.BTTF2),
			},
			subtotal: 3000,
			discount: Discount{DistinctVolumes: 1, BaseCents: 3000},
			total:    3000,
		},
		{
			name: "two titles of one volume and another volume reach 10 %",
			lines: []cart.Line{
				line("BTTF 2", 1, cart.BTTF2),
				line("Retour vers le futur 2", 1, cart.BTTF2),
				bttf1,
			},
			subtotal: 4500,
			discount: Discount{DistinctVolumes: 2, Percent: 10, BaseCents: 4500, AmountCents: 450},
			total:    4050,
		},
		{
			name:     "other films only",
			lines:    []cart.Line{chevre, line("Le Grand Bleu", 3, cart.Other)},
			subtotal: 8000,
			discount: Discount{},
			total:    8000,
		},
		{
			name:     "many copies",
			lines:    []cart.Line{line("Back to the Future", 100, cart.BTTF1), bttf2, line("Heat", 2, cart.Other)},
			subtotal: 155500,
			discount: Discount{DistinctVolumes: 2, Percent: 10, BaseCents: 151500, AmountCents: 15150},
			total:    140350,
		},
		{
			name:     "the most a cart may hold of each volume",
			lines:    []cart.Line{line("1", cart.MaxQuantity, cart.BTTF1), line("2", cart.MaxQuantity, cart.BTTF2), line("3", cart.MaxQuantity, cart.BTTF3)},
			subtotal: 4_500_000,
			discount: Discount{DistinctVolumes: 3, Percent: 20, BaseCents: 4_500_000, AmountCents: 900_000},
			total:    3_600_000,
		},
		{
			name:  "no lines",
			lines: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q := Default().Price(tt.lines)
			if q.SubtotalCents != tt.subtotal {
				t.Errorf("subtotal = %d, want %d", q.SubtotalCents, tt.subtotal)
			}
			if q.Discount != tt.discount {
				t.Errorf("discount = %+v, want %+v", q.Discount, tt.discount)
			}
			if q.TotalCents != tt.total {
				t.Errorf("total = %d, want %d", q.TotalCents, tt.total)
			}
			if len(q.Lines) != len(tt.lines) {
				t.Fatalf("%d priced lines, want %d", len(q.Lines), len(tt.lines))
			}
			sum := 0
			for i, l := range q.Lines {
				if l.Line != tt.lines[i] {
					t.Errorf("line %d = %+v, want %+v", i, l.Line, tt.lines[i])
				}
				if l.SubtotalCents != l.UnitCents*l.Quantity {
					t.Errorf("line %d: subtotal %d is not %d × %d", i, l.SubtotalCents, l.UnitCents, l.Quantity)
				}
				sum += l.SubtotalCents
			}
			if sum != q.SubtotalCents {
				t.Errorf("lines add up to %d, subtotal is %d", sum, q.SubtotalCents)
			}
		})
	}
}

func TestUnitCents(t *testing.T) {
	c := Default()
	for f, want := range map[cart.Film]int{cart.BTTF1: 1500, cart.BTTF2: 1500, cart.BTTF3: 1500, cart.Other: 2000} {
		if got := c.UnitCents(f); got != want {
			t.Errorf("UnitCents(%s) = %d, want %d", f, got, want)
		}
	}
}

// The default catalog always divides exactly; a catalog with odd prices shows
// the rounding, half up.
func TestPriceRoundsHalfUp(t *testing.T) {
	c := Default()
	c.Volumes[0].UnitCents = 1505
	c.Volumes[1].UnitCents = 1504
	tests := []struct {
		name   string
		lines  []cart.Line
		amount int
	}{
		{"half rounds up", []cart.Line{line("1", 1, cart.BTTF1), line("3", 1, cart.BTTF3)}, 301},         // 10 % of 3005
		{"below half rounds down", []cart.Line{line("2", 1, cart.BTTF2), line("3", 1, cart.BTTF3)}, 300}, // 10 % of 3004
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := c.Price(tt.lines).Discount.AmountCents; got != tt.amount {
				t.Errorf("amount = %d, want %d", got, tt.amount)
			}
		})
	}
}
