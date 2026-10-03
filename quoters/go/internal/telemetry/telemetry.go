// Package telemetry exports traces to Langfuse through trpc-agent-go, when
// Langfuse is configured, and does nothing otherwise.
//
// Spans are opened with trpc-agent-go's tracer (telemetry/trace.Tracer),
// which is a no-op until Start succeeds: code that traces never checks
// whether tracing is on.
package telemetry

import (
	"cmp"
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"trpc.group/trpc-go/trpc-agent-go/telemetry/langfuse"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"

	"github.com/func-it/delorean/quoters/go/internal/pipeline"
)

// Langfuse is the project the traces go to, as the environment sets it.
type Langfuse struct {
	PublicKey string
	SecretKey string
	// BaseURL is where the public API answers: "https://cloud.langfuse.com".
	BaseURL string
	// Insecure sends traces over plain HTTP: a local Langfuse.
	Insecure bool
}

// FromEnv reads Langfuse as the Langfuse SDKs do: LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL, or LANGFUSE_HOST, a URL too;
// its scheme says HTTP or HTTPS. ok is false when none is set; a partial
// setting is an error, not a silent no-op, in the words every quoter uses.
func FromEnv() (lf Langfuse, ok bool, err error) {
	lf = Langfuse{
		PublicKey: os.Getenv("LANGFUSE_PUBLIC_KEY"),
		SecretKey: os.Getenv("LANGFUSE_SECRET_KEY"),
		BaseURL:   strings.TrimRight(cmp.Or(os.Getenv("LANGFUSE_BASE_URL"), os.Getenv("LANGFUSE_HOST")), "/"),
	}
	if lf.PublicKey == "" && lf.SecretKey == "" && lf.BaseURL == "" {
		return Langfuse{}, false, nil
	}
	var missing []string
	for _, v := range []struct{ name, value string }{
		{"LANGFUSE_PUBLIC_KEY", lf.PublicKey},
		{"LANGFUSE_SECRET_KEY", lf.SecretKey},
		{"LANGFUSE_BASE_URL (or LANGFUSE_HOST)", lf.BaseURL},
	} {
		if v.value == "" {
			missing = append(missing, v.name)
		}
	}
	if len(missing) > 0 {
		return Langfuse{}, false, fmt.Errorf("Langfuse is half configured: %s missing", and(missing))
	}
	u, err := url.Parse(lf.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Langfuse{}, false, fmt.Errorf("LANGFUSE_BASE_URL is %q, not an http(s) URL", lf.BaseURL)
	}
	lf.Insecure = u.Scheme == "http"
	return lf, true, nil
}

// and lists names as a sentence does: "a", "a and b", "a, b and c".
func and(names []string) string {
	if len(names) == 1 {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// host is the base URL as the OTLP exporter wants it: "hostname:port".
func (lf Langfuse) host() string {
	u, err := url.Parse(lf.BaseURL)
	switch {
	case err != nil:
		return ""
	case u.Port() != "":
		return u.Host
	case u.Scheme == "http":
		return u.Host + ":80"
	}
	return u.Host + ":443"
}

// Start begins exporting to Langfuse when the environment configures it (see
// FromEnv). enabled says whether it did; shutdown flushes and stops, and is
// never nil. The tracer is the service's own, delorean at version, which
// gives every span what the Langfuse SDKs give theirs (propagator).
func Start(ctx context.Context, version string) (shutdown func(context.Context) error, enabled bool, err error) {
	noop := func(context.Context) error { return nil }
	lf, ok, err := FromEnv()
	if err != nil || !ok {
		return noop, false, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", "delorean"),
			attribute.String("service.version", version),
		)),
		sdktrace.WithSpanProcessor(propagator{common: fromEnv(os.Getenv)}),
	)
	// langfuse.Start adds its exporter to this provider rather than make its own
	atrace.TracerProvider = provider
	opts := []langfuse.Option{
		langfuse.WithPublicKey(lf.PublicKey),
		langfuse.WithSecretKey(lf.SecretKey),
		langfuse.WithHost(lf.host()),
	}
	if lf.Insecure {
		opts = append(opts, langfuse.WithInsecure())
	}
	clean, err := langfuse.Start(ctx, opts...)
	if err != nil {
		return noop, false, fmt.Errorf("langfuse: %w", err)
	}
	return clean, true, nil
}

// propagator sets on every span, as it starts, the environment and release
// of the service, and what the quote under way propagates: its trace's name
// and tags, its user and session (pipeline.Propagated).
type propagator struct{ common []attribute.KeyValue }

// fromEnv is the environment and release, as the Langfuse SDKs read them.
func fromEnv(getenv func(string) string) []attribute.KeyValue {
	var kv []attribute.KeyValue
	if v := getenv("LANGFUSE_TRACING_ENVIRONMENT"); v != "" {
		kv = append(kv, attribute.String("langfuse.environment", v))
	}
	if v := getenv("LANGFUSE_RELEASE"); v != "" {
		kv = append(kv, attribute.String("langfuse.release", v))
	}
	return kv
}

func (p propagator) OnStart(parent context.Context, s sdktrace.ReadWriteSpan) {
	s.SetAttributes(p.common...)
	s.SetAttributes(pipeline.Propagated(parent)...)
}

func (propagator) OnEnd(sdktrace.ReadOnlySpan)      {}
func (propagator) Shutdown(context.Context) error   { return nil }
func (propagator) ForceFlush(context.Context) error { return nil }
