// Package httpapi serves the contract of api/openapi.yaml: the health, the
// catalog, and the quotes. Routes and models are generated from the contract
// (openapi.gen.go); this package decodes, validates, runs the pipeline and
// answers, every error as an RFC 9457 problem.
package httpapi

//go:generate go tool oapi-codegen -config oapi-codegen.yaml ../../../../api/openapi.yaml

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/cart"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
)

// Config is what the HTTP surface serves.
type Config struct {
	Pipeline *pipeline.Pipeline
	// Version is the build's, as /healthz reports it.
	Version string
	// Tracing says whether traces are exported to Langfuse.
	Tracing bool
	// MaxBodyBytes bounds a request body.
	MaxBodyBytes int64
	// RequestTimeout is the budget of a quote, model calls included.
	RequestTimeout time.Duration
	Log            *slog.Logger
}

// server implements the generated ServerInterface.
type server struct {
	Config
}

// New returns the HTTP handler of the API.
func New(cfg Config) http.Handler {
	s := &server{Config: cfg}
	mux := http.NewServeMux()
	HandlerWithOptions(s, StdHTTPServerOptions{
		BaseRouter: mux,
		// a header the generated wrapper cannot bind, such as one given twice
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			writeProblem(w, r, newProblem(http.StatusBadRequest, ProblemCodeMalformedRequest, err.Error()), nil)
		},
	})
	return withRequestID(s.withLogging(unrouted(mux)))
}

// GetHealth answers GET /healthz.
func (s *server) GetHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, Health{
		Status:         HealthStatusOk,
		Implementation: HealthImplementationGo,
		Version:        s.Version,
		Engines:        HealthEngines(s.Pipeline.Engines.Name),
		Tracing:        s.Tracing,
	})
}

// GetCatalog answers GET /v1/catalog.
func (s *server) GetCatalog(w http.ResponseWriter, r *http.Request) {
	c := s.Pipeline.Catalog
	films := make([]CatalogFilm, len(c.Volumes))
	for i, v := range c.Volumes {
		films[i] = CatalogFilm{Id: Film(v.Film), Title: v.Title, Volume: v.Film.Volume(), UnitPriceCents: v.UnitCents}
	}
	discounts := make([]SagaDiscount, len(c.Tiers))
	for i, t := range c.Tiers {
		discounts[i] = SagaDiscount{DistinctVolumes: t.DistinctVolumes, Percent: t.Percent}
	}
	writeJSON(w, r, http.StatusOK, Catalog{
		Currency:                CatalogCurrencyEUR,
		Films:                   films,
		OtherFilmUnitPriceCents: c.OtherUnitCents,
		SagaDiscounts:           discounts,
		Limits: Limits{
			MaxBodyBytes:      int(s.MaxBodyBytes),
			MaxInputTokens:    s.Pipeline.MaxInputTokens,
			MaxCopiesPerTitle: cart.MaxQuantity,
		},
	})
}
