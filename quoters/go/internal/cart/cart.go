// Package cart is the vocabulary of a reading: the films the shop prices, and
// the lines a customer's text is read into. It holds no logic beyond what a
// value can tell about itself.
package cart

// Film is what a title is identified as. The values are the answers the
// identification engine may give, and the ids of the API contract.
type Film string

const (
	BTTF1 Film = "bttf_1"
	BTTF2 Film = "bttf_2"
	BTTF3 Film = "bttf_3"
	Other Film = "other"
)

// Films are every possible identification, saga volumes first, in order.
var Films = []Film{BTTF1, BTTF2, BTTF3, Other}

// Valid reports whether f is one of Films.
func (f Film) Valid() bool {
	switch f {
	case BTTF1, BTTF2, BTTF3, Other:
		return true
	}
	return false
}

// Volume is the saga volume of f, 1 to 3, and 0 for another film.
func (f Film) Volume() int {
	switch f {
	case BTTF1:
		return 1
	case BTTF2:
		return 2
	case BTTF3:
		return 3
	}
	return 0
}

// InSaga reports whether f is a Back to the Future volume.
func (f Film) InSaga() bool { return f.Volume() > 0 }

// MaxQuantity is the most copies of one title a cart may ask, its mentions
// merged; above, the cart is refused. No DVD shop would serve more, and every
// amount in cents stays far from overflow.
const MaxQuantity = 1000

// Mention is a film the customer asks to buy, as the parser reads it: the
// title as written, and how many copies.
type Mention struct {
	Title    string `json:"title"`
	Quantity int    `json:"quantity"`
	// Film is set when the parser identified the title too; the title is
	// then not put to the identifier.
	Film Film `json:"film,omitempty"`
}

// Line is a mention once its title is identified.
type Line struct {
	Title    string `json:"title"`
	Quantity int    `json:"quantity"`
	Film     Film   `json:"film"`
	// Confidence is the calibrated confidence of the identification, 0 to 1.
	Confidence float64 `json:"confidence"`
}
