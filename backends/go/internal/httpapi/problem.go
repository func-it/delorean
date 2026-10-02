package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

var titles = map[ProblemCode]string{
	ProblemCodeMalformedRequest:  "Malformed request",
	ProblemCodePayloadTooLarge:   "Payload too large",
	ProblemCodeEmptyCart:         "Cart rejected",
	ProblemCodeTooLong:           "Cart rejected",
	ProblemCodeInjection:         "Cart rejected",
	ProblemCodeInvalidRequest:    "Cart rejected",
	ProblemCodeNoFilm:            "Cart rejected",
	ProblemCodeQuantityTooLarge:  "Cart rejected",
	ProblemCodeUnfaithfulReading: "Cart rejected",
	ProblemCodeEngineUnavailable: "Engine unavailable",
	ProblemCodeNotFound:          "Not found",
	ProblemCodeMethodNotAllowed:  "Method not allowed",
	ProblemCodeInternal:          "Internal error",
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
	p := newProblem(http.StatusUnprocessableEntity, ProblemCode(rej.Code), rej.Detail)
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
	ex := exchangeOf(r)
	ex.code, ex.cause = p.Code, cause
	p.RequestId = new(ex.id)
	write(w, r, p.Status, "application/problem+json", p)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	write(w, r, status, "application/json", v)
}

func write(w http.ResponseWriter, r *http.Request, status int, contentType string, v any) {
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// the status is sent: all that is left is to say so in the log
		exchangeOf(r).cause = err
	}
}
