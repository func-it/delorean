package httpapi

import (
	"net/http"
	"strconv"

	"github.com/func-it/delorean/quoters/go/internal/jsonx"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

var titles = map[ProblemCode]string{
	ProblemCodeMalformedRequest:   "Malformed request",
	ProblemCodePayloadTooLarge:    "Payload too large",
	ProblemCodeEmptyCart:          "Cart rejected",
	ProblemCodeTooLong:            "Cart rejected",
	ProblemCodeInjection:          "Cart rejected",
	ProblemCodeInvalidRequest:     "Cart rejected",
	ProblemCodeNoFilm:             "Cart rejected",
	ProblemCodeQuantityTooLarge:   "Cart rejected",
	ProblemCodeUnfaithfulReading:  "Cart rejected",
	ProblemCodeEngineUnavailable:  "Engine unavailable",
	ProblemCodeQuantityUnverified: "Quantities not verified",
	ProblemCodeNotFound:           "Not found",
	ProblemCodeMethodNotAllowed:   "Method not allowed",
	ProblemCodeInternal:           "Internal error",
}

func newProblem(status int, code ProblemCode, detail string) Problem {
	return Problem{Type: "/problems/" + string(code), Title: titles[code], Status: status, Code: code, Detail: &detail}
}

func internalProblem() Problem {
	return newProblem(http.StatusInternalServerError, ProblemCodeInternal,
		"Something went wrong on our side; the request id tells us where.")
}

// rejected is the problem of a cart a stage refused, with the facts that
// decided and what the reading cost.
func (s *server) rejected(rej *pipeline.Rejection) Problem {
	status := http.StatusUnprocessableEntity
	if rej.Code == pipeline.CodeQuantityUnverified {
		// nothing is wrong with the cart: the same one may be priced on a retry
		status = http.StatusServiceUnavailable
	}
	p := newProblem(status, ProblemCode(rej.Code), rej.Detail)
	if rej.Tokens != nil {
		p.Tokens = &Problem_Tokens{Count: rej.Tokens.Count, Max: rej.Tokens.Max}
	}
	if rej.Guard != nil {
		p.Guard = new(guardOutcome(*rej.Guard))
	}
	if rej.Copies != nil {
		p.Quantity = &Problem_Quantity{Title: rej.Copies.Title, Count: rej.Copies.Count, Max: rej.Copies.Max}
	}
	if rej.Judgement != nil {
		p.Judge = new(s.judge(*rej.Judgement))
	}
	p.Usage = new(s.usage(rej.Report))
	return p
}

// writeProblem answers with p. cause is what went wrong behind it: logged,
// never shown.
func writeProblem(w http.ResponseWriter, r *http.Request, p Problem, cause error) {
	problemResponse(r, p, cause).send(w, r)
}

// problemResponse is p, with the request's id, ready to send; the exchange
// keeps its code and cause for the log.
func problemResponse(r *http.Request, p Problem, cause error) *response {
	ex := exchangeOf(r)
	ex.code, ex.cause = p.Code, cause
	p.RequestId = new(ex.id)
	return jsonResponse(p.Status, "application/problem+json", p)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	jsonResponse(status, "application/json", v).send(w, r)
}

// response is an answer encoded before it is sent: a trace can keep its
// very body.
type response struct {
	status      int
	contentType string
	body        []byte
	err         error
}

// jsonResponse is v as every quoter writes it (jsonx): keys in the
// contract's order, the generated structs'.
func jsonResponse(status int, contentType string, v any) *response {
	body, err := jsonx.Marshal(v)
	return &response{status: status, contentType: contentType, body: body, err: err}
}

func (rsp *response) send(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", rsp.contentType)
	if rsp.err == nil { // a length, not chunks, whatever the size, as every quoter sends
		w.Header().Set("Content-Length", strconv.Itoa(len(rsp.body)))
	}
	w.WriteHeader(rsp.status)
	if rsp.err != nil {
		// the status is sent: all that is left is to say so in the log
		exchangeOf(r).cause = rsp.err
		return
	}
	if _, err := w.Write(rsp.body); err != nil {
		exchangeOf(r).cause = err
	}
}
