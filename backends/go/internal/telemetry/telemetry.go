// Package telemetry exports traces to Langfuse through trpc-agent-go, when
// Langfuse is configured, and does nothing otherwise.
//
// Spans are opened with trpc-agent-go's tracer (telemetry/trace.Tracer),
// which is a no-op until Start succeeds: code that traces never checks
// whether tracing is on.
package telemetry

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"trpc.group/trpc-go/trpc-agent-go/telemetry/langfuse"
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

// FromEnv reads Langfuse from LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL — or LANGFUSE_HOST, "cloud.langfuse.com:443" or
// "localhost:3000" — and LANGFUSE_INSECURE. ok is false when none is set; a
// partial setting is an error, not a silent no-op.
func FromEnv() (lf Langfuse, ok bool, err error) {
	lf = Langfuse{
		PublicKey: os.Getenv("LANGFUSE_PUBLIC_KEY"),
		SecretKey: os.Getenv("LANGFUSE_SECRET_KEY"),
		BaseURL:   baseURL(os.Getenv("LANGFUSE_BASE_URL"), os.Getenv("LANGFUSE_HOST")),
	}
	if lf.PublicKey == "" && lf.SecretKey == "" && lf.BaseURL == "" {
		return Langfuse{}, false, nil
	}
	var missing []string
	for _, v := range []struct{ name, value string }{
		{"LANGFUSE_PUBLIC_KEY", lf.PublicKey},
		{"LANGFUSE_SECRET_KEY", lf.SecretKey},
		{"LANGFUSE_BASE_URL or LANGFUSE_HOST", lf.BaseURL},
	} {
		if v.value == "" {
			missing = append(missing, v.name)
		}
	}
	if len(missing) > 0 {
		return Langfuse{}, false, fmt.Errorf("langfuse: %s missing", strings.Join(missing, ", "))
	}
	u, err := url.Parse(lf.BaseURL)
	if err != nil || u.Host == "" {
		return Langfuse{}, false, fmt.Errorf("langfuse: base URL %q is not a URL", lf.BaseURL)
	}
	lf.Insecure = u.Scheme == "http" || os.Getenv("LANGFUSE_INSECURE") == "true"
	return lf, true, nil
}

// baseURL is LANGFUSE_BASE_URL, or a URL made of LANGFUSE_HOST: plain HTTP
// for a local host, HTTPS otherwise.
func baseURL(base, host string) string {
	if base != "" {
		return strings.TrimRight(base, "/")
	}
	switch {
	case host == "":
		return ""
	case strings.Contains(host, "://"):
		return strings.TrimRight(host, "/")
	case strings.HasPrefix(host, "localhost"), strings.HasPrefix(host, "127.0.0.1"):
		return "http://" + host
	}
	return "https://" + host
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
// never nil.
func Start(ctx context.Context) (shutdown func(context.Context) error, enabled bool, err error) {
	noop := func(context.Context) error { return nil }
	lf, ok, err := FromEnv()
	if err != nil || !ok {
		return noop, false, err
	}
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
