package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// exchange is what the middleware and the handlers share about one request:
// its id, and how it ended, for the log line.
type exchange struct {
	id string
	// code is the problem answered, if any.
	code ProblemCode
	// cause is what went wrong behind a 5xx, or a response that was not
	// written.
	cause error
	// degraded: a stage failed and the quote went on without it, or was
	// refused without it (the recount).
	degraded bool
}

type exchangeKey struct{}

// exchangeOf is the exchange of r, or a blank one outside withRequestID.
func exchangeOf(r *http.Request) *exchange {
	if ex, ok := r.Context().Value(exchangeKey{}).(*exchange); ok {
		return ex
	}
	return &exchange{}
}

// withRequestID gives every request an id: the client's X-Request-Id when it
// has the contract's format, a new one otherwise. The response echoes it.
func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !requestIDFormat.MatchString(id) {
			id = rand.Text()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), exchangeKey{}, &exchange{id: id})))
	})
}

// withLogging logs every request in one line once answered, and answers a
// panic with a 500 problem.
func (s *server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w}
		defer func() {
			if v := recover(); v != nil {
				if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(v) // the handler cut the connection on purpose
				}
				err := fmt.Errorf("panic: %v\n%s", v, debug.Stack())
				if rec.status == 0 {
					writeProblem(rec, r, internalProblem(), err)
				} else {
					exchangeOf(r).cause = err
				}
			}
			s.logRequest(r, rec, time.Since(start))
		}()
		next.ServeHTTP(rec, r)
	})
}

func (s *server) logRequest(r *http.Request, rec *recorder, took time.Duration) {
	ex := exchangeOf(r)
	status := rec.status
	if status == 0 { // nothing written: net/http answers 200
		status = http.StatusOK
	}
	attrs := []slog.Attr{
		slog.String("request_id", ex.id),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Int("status", status),
		slog.Int64("ms", took.Milliseconds()),
		slog.Int("bytes", rec.bytes),
	}
	if ex.code != "" {
		attrs = append(attrs, slog.String("code", string(ex.code)))
	}
	if ex.cause != nil {
		attrs = append(attrs, slog.String("err", ex.cause.Error()))
	}
	if ex.degraded {
		attrs = append(attrs, slog.String("degraded", string(pipeline.StageRecount)))
	}
	level := slog.LevelInfo
	if status >= http.StatusInternalServerError {
		level = slog.LevelError
	}
	s.Log.LogAttrs(r.Context(), level, "request", attrs...)
}

// recorder notes the status and the size of a response.
type recorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// unrouted answers in problem+json what the mux answers in text/plain: 404
// for an unknown path, 405 with Allow for a known path under another method.
func unrouted(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, pattern := mux.Handler(r)
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		// the mux's own answer says which of the two; its text is not ours
		probe := &headerProbe{header: http.Header{}}
		h.ServeHTTP(probe, r)
		if probe.status == http.StatusMethodNotAllowed {
			allow := probe.header.Get("Allow")
			w.Header().Set("Allow", allow)
			writeProblem(w, r, newProblem(http.StatusMethodNotAllowed, ProblemCodeMethodNotAllowed,
				fmt.Sprintf("%s answers %s, not %s.", r.URL.Path, allow, r.Method)), nil)
			return
		}
		writeProblem(w, r, newProblem(http.StatusNotFound, ProblemCodeNotFound,
			fmt.Sprintf("Nothing at %s.", r.URL.Path)), nil)
	})
}

// headerProbe keeps the status and the headers of a response, and drops its
// body.
type headerProbe struct {
	header http.Header
	status int
}

func (p *headerProbe) Header() http.Header         { return p.header }
func (p *headerProbe) Write(b []byte) (int, error) { return len(b), nil }
func (p *headerProbe) WriteHeader(status int)      { p.status = status }
