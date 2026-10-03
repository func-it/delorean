package telemetry

import (
	"context"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	atrace "trpc.group/trpc-go/trpc-agent-go/telemetry/trace"

	"github.com/func-it/delorean/quoters/go/internal/fake"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
	"github.com/func-it/delorean/quoters/go/internal/prepare"
	"github.com/func-it/delorean/quoters/go/internal/pricing"
)

// env sets every variable FromEnv reads: unset ones are empty.
func env(t *testing.T, vars map[string]string) {
	t.Helper()
	for _, k := range []string{"LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_HOST"} {
		t.Setenv(k, vars[k])
	}
}

// Langfuse is on with both keys and an address, off with nothing, and a
// partial setting says what is missing instead of tracing nothing silently.
func TestFromEnv(t *testing.T) {
	keys := map[string]string{"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"}
	with := func(k, v string) map[string]string {
		m := map[string]string{k: v}
		for k, v := range keys {
			m[k] = v
		}
		return m
	}
	for _, tc := range []struct {
		name     string
		vars     map[string]string
		ok       bool
		err      string
		host     string
		insecure bool
	}{
		{name: "nothing set", vars: nil},
		{name: "cloud", vars: with("LANGFUSE_BASE_URL", "https://cloud.langfuse.com/"), ok: true, host: "cloud.langfuse.com:443"},
		{name: "local, by base URL", vars: with("LANGFUSE_BASE_URL", "http://localhost:3000"), ok: true, host: "localhost:3000", insecure: true},
		{name: "local, by host", vars: with("LANGFUSE_HOST", "http://localhost:3000"), ok: true, host: "localhost:3000", insecure: true},
		{name: "host with its port", vars: with("LANGFUSE_HOST", "https://langfuse.example.com:8443"), ok: true, host: "langfuse.example.com:8443"},
		{name: "a host that is not a URL", vars: with("LANGFUSE_HOST", "cloud.langfuse.com"), err: `LANGFUSE_BASE_URL is "cloud.langfuse.com", not an http(s) URL`},
		{name: "no address", vars: keys, err: "Langfuse is half configured: LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing"},
		{name: "no secret", vars: map[string]string{"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_HOST": "https://cloud.langfuse.com"}, err: "Langfuse is half configured: LANGFUSE_SECRET_KEY missing"},
		{name: "a public key alone", vars: map[string]string{"LANGFUSE_PUBLIC_KEY": "pk"}, err: "Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env(t, tc.vars)
			lf, ok, err := FromEnv()
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("err %v, want %q", err, tc.err)
				}
				return
			}
			if err != nil || ok != tc.ok {
				t.Fatalf("ok %v, err %v", ok, err)
			}
			if ok && (lf.host() != tc.host || lf.Insecure != tc.insecure) {
				t.Errorf("host %q insecure %v, want %q %v", lf.host(), lf.Insecure, tc.host, tc.insecure)
			}
		})
	}
}

// Without Langfuse, Start is a no-op whose shutdown can still be called.
func TestStartWithoutLangfuseIsANoOp(t *testing.T) {
	env(t, nil)
	shutdown, enabled, err := Start(context.Background(), "test")
	if err != nil || enabled || shutdown == nil {
		t.Fatalf("enabled %v, err %v", enabled, err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Error(err)
	}
}

// A partial setting is reported by Start too, with a usable shutdown.
func TestStartReportsAPartialSetting(t *testing.T) {
	env(t, map[string]string{"LANGFUSE_PUBLIC_KEY": "pk"})
	shutdown, enabled, err := Start(context.Background(), "test")
	if err == nil || enabled || shutdown == nil {
		t.Fatalf("enabled %v, err %v", enabled, err)
	}
}

// Every observation of a quote carries its trace's name and tags, its user
// and session, and the service's environment and release, as the Langfuse
// SDKs give them to every span.
func TestPropagatorMarksEveryObservation(t *testing.T) {
	spans := tracetest.NewSpanRecorder()
	env := map[string]string{"LANGFUSE_TRACING_ENVIRONMENT": "ci", "LANGFUSE_RELEASE": "r1"}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(propagator{common: fromEnv(func(k string) string { return env[k] })}),
		sdktrace.WithSpanProcessor(spans),
	)
	previous := atrace.Tracer
	atrace.Tracer = provider.Tracer("test")
	t.Cleanup(func() { atrace.Tracer = previous })
	counter, err := prepare.NewCounter()
	if err != nil {
		t.Fatal(err)
	}
	p := &pipeline.Pipeline{Engines: fake.New(), Counter: counter, Catalog: pricing.Default(), MaxInputTokens: 2048,
		GuardMinConfidence: 0.5, JudgeThreshold: 0.5, ReadAttempts: 3}
	if _, err := p.Quote(t.Context(), pipeline.Request{Cart: "Back to the Future 1", UserID: "marty", SessionID: "s-1955"}); err != nil {
		t.Fatal(err)
	}
	ended := spans.Ended()
	if len(ended) < 8 {
		t.Fatalf("%d spans", len(ended))
	}
	for _, s := range ended {
		attrs := map[string]string{}
		for _, kv := range s.Attributes() {
			attrs[string(kv.Key)] = kv.Value.String()
		}
		for k, want := range map[string]string{
			"langfuse.trace.name": "quote", "langfuse.trace.tags": `["quoter:go","engines:fake"]`,
			"user.id": "marty", "session.id": "s-1955", "langfuse.environment": "ci", "langfuse.release": "r1",
		} {
			if attrs[k] != want {
				t.Errorf("%s: %s = %q, want %q", s.Name(), k, attrs[k], want)
			}
		}
	}
}
