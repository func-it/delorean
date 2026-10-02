package pipeline

// Code says which stage refused a cart, and why. The values are the API's
// problem codes.
type Code string

const (
	CodeEmptyCart         Code = "empty_cart"         // prepare
	CodeTooLong           Code = "too_long"           // prepare
	CodeInjection         Code = "injection"          // guard
	CodeInvalidRequest    Code = "invalid_request"    // guard
	CodeNoFilm            Code = "no_film"            // parse
	CodeQuantityTooLarge  Code = "quantity_too_large" // parse
	CodeUnfaithfulReading Code = "unfaithful_reading" // judge
)

// Rejection is a cart a stage refused to price: the facts that decided, and
// what the reading took up to there.
type Rejection struct {
	Code Code
	// Detail says why, in a sentence for the customer.
	Detail string
	// Tokens is set by too_long, Guard by injection and invalid_request,
	// Copies by quantity_too_large, Judgement by unfaithful_reading.
	Tokens    *Tokens
	Guard     *GuardVerdict
	Copies    *Copies
	Judgement *Judgement
	Report    Report
}

// Tokens is the size of a cart against its limit.
type Tokens struct {
	Count int
	Max   int
}

// Copies is how many copies of a title a cart asks, against the limit.
type Copies struct {
	Title string
	Count int
	Max   int
}

func (r *Rejection) Error() string {
	return "cart rejected: " + string(r.Code) + ": " + r.Detail
}
