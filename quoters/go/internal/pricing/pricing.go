// Package pricing prices identified lines in integer cents: what each film
// costs, and the Back to the Future discount. It never sees the customer's
// text, and no model ever computes a price.
package pricing

import "github.com/func-it/delorean/quoters/go/internal/cart"

// Catalog is what the shop sells and how it prices it.
type Catalog struct {
	// Volumes are the saga volumes, in order.
	Volumes []Volume
	// OtherUnitCents is the price of any film outside the saga.
	OtherUnitCents int
	// Tiers are the saga discounts; the highest one reached applies.
	Tiers []Tier
}

// Volume is a Back to the Future film as the shop sells it.
type Volume struct {
	Film      cart.Film
	Title     string
	UnitCents int
}

// Tier takes Percent off every saga DVD once a cart holds DistinctVolumes
// different volumes.
type Tier struct {
	DistinctVolumes int
	Percent         int
}

// Default is the shop's catalog: 15 EUR a volume, 20 EUR any other film,
// 10 % off the saga with two distinct volumes, 20 % with three.
func Default() Catalog {
	return Catalog{
		Volumes: []Volume{
			{Film: cart.BTTF1, Title: "Back to the Future", UnitCents: 1500},
			{Film: cart.BTTF2, Title: "Back to the Future Part II", UnitCents: 1500},
			{Film: cart.BTTF3, Title: "Back to the Future Part III", UnitCents: 1500},
		},
		OtherUnitCents: 2000,
		Tiers:          []Tier{{DistinctVolumes: 2, Percent: 10}, {DistinctVolumes: 3, Percent: 20}},
	}
}

// UnitCents is the price of one copy of f.
func (c Catalog) UnitCents(f cart.Film) int {
	for _, v := range c.Volumes {
		if v.Film == f {
			return v.UnitCents
		}
	}
	return c.OtherUnitCents
}

// Line is a line with its price.
type Line struct {
	cart.Line
	UnitCents     int
	SubtotalCents int
}

// Discount is the saga discount of a cart. Percent is 0 when no tier is
// reached.
type Discount struct {
	DistinctVolumes int
	Percent         int
	// BaseCents is the subtotal of the saga lines, on which Percent applies.
	BaseCents   int
	AmountCents int
}

// Quote is a priced cart.
type Quote struct {
	Lines         []Line
	SubtotalCents int
	Discount      Discount
	TotalCents    int
}

// Price prices lines: each at its unit price, then the highest tier the
// distinct saga volumes reach, taken off the saga lines only. Two lines of
// one volume count once among the distinct volumes, and both in the base.
func (c Catalog) Price(lines []cart.Line) Quote {
	q := Quote{Lines: make([]Line, 0, len(lines))}
	volumes := map[cart.Film]bool{}
	for _, l := range lines {
		unit := c.UnitCents(l.Film)
		sub := unit * l.Quantity
		q.Lines = append(q.Lines, Line{Line: l, UnitCents: unit, SubtotalCents: sub})
		q.SubtotalCents += sub
		if l.Film.InSaga() {
			volumes[l.Film] = true
			q.Discount.BaseCents += sub
		}
	}

	d := &q.Discount
	d.DistinctVolumes = len(volumes)
	reached := Tier{}
	for _, t := range c.Tiers {
		if d.DistinctVolumes >= t.DistinctVolumes && t.DistinctVolumes > reached.DistinctVolumes {
			reached = t
		}
	}
	d.Percent = reached.Percent
	// to the cent, half up; on this catalog the division is always exact
	d.AmountCents = (d.BaseCents*d.Percent + 50) / 100
	q.TotalCents = q.SubtotalCents - d.AmountCents
	return q
}
