package telemetry

import (
	"context"
	"strings"
	"testing"
)

// env sets every variable FromEnv reads: unset ones are empty.
func env(t *testing.T, vars map[string]string) {
	t.Helper()
	for _, k := range []string{"LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_HOST", "LANGFUSE_INSECURE"} {
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
		{name: "local, by host", vars: with("LANGFUSE_HOST", "localhost:3000"), ok: true, host: "localhost:3000", insecure: true},
		{name: "host with its port", vars: with("LANGFUSE_HOST", "langfuse.example.com:8443"), ok: true, host: "langfuse.example.com:8443"},
		{name: "insecure asked", vars: map[string]string{"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk",
			"LANGFUSE_BASE_URL": "https://langfuse.internal", "LANGFUSE_INSECURE": "true"}, ok: true, host: "langfuse.internal:443", insecure: true},
		{name: "no address", vars: keys, err: "LANGFUSE_BASE_URL or LANGFUSE_HOST missing"},
		{name: "no secret", vars: map[string]string{"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_HOST": "cloud.langfuse.com"}, err: "LANGFUSE_SECRET_KEY missing"},
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
	shutdown, enabled, err := Start(context.Background())
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
	shutdown, enabled, err := Start(context.Background())
	if err == nil || enabled || shutdown == nil {
		t.Fatalf("enabled %v, err %v", enabled, err)
	}
}
