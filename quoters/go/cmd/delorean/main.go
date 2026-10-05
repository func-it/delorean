// delorean prices a free-text DVD cart with the Back to the Future promotion:
// models read the cart, code computes the price.
//
//	delorean [serve]     the HTTP API (api/openapi.yaml), configured by the environment
//	delorean version     the version of this build
//	delorean tokenizer   loads the token vocabulary, offline, and says its size
//	delorean healthcheck asks the running service for /healthz: exit 0 when it is up
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/func-it/delorean/quoters/go/internal/config"
	"github.com/func-it/delorean/quoters/go/internal/fake"
	"github.com/func-it/delorean/quoters/go/internal/httpapi"
	"github.com/func-it/delorean/quoters/go/internal/live"
	"github.com/func-it/delorean/quoters/go/internal/pipeline"
	"github.com/func-it/delorean/quoters/go/internal/prepare"
	"github.com/func-it/delorean/quoters/go/internal/pricing"
	"github.com/func-it/delorean/quoters/go/internal/telemetry"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "delorean:", err)
		if errors.As(err, new(usageError)) {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

// usageError is a command line that names no command: exit code 2.
type usageError string

func (e usageError) Error() string { return string(e) }

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	if len(args) > 1 {
		return usageError(fmt.Sprintf("unexpected argument %q", args[1]))
	}
	switch cmd {
	case "serve":
		return serve()
	case "version":
		fmt.Println(version)
		return nil
	case "healthcheck":
		return healthcheck(os.Getenv, 3*time.Second)
	case "tokenizer":
		counter, err := prepare.NewCounter()
		if err != nil {
			return err
		}
		fmt.Printf("%s: %d ranks\n", prepare.Encoding, counter.Ranks())
		return nil
	}
	return usageError(fmt.Sprintf("unknown command %q: want serve, healthcheck, version or tokenizer", cmd))
}

// healthcheck asks the service on this machine for /healthz, for a container
// that has no shell or curl to do it (compose's healthcheck runs this command
// in the image). It reads PORT, as the service does, and nothing else: it must
// not fail on a setting the service accepted. Up is a 200 with the health
// JSON, said by nothing at all; anything else is one short line on stderr and
// exit code 1.
func healthcheck(getenv func(string) string, timeout time.Duration) error {
	port := 24791
	if v := getenv("PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("healthcheck: PORT=%q is not a port", v)
		}
		port = n
	}
	client := &http.Client{Timeout: timeout}
	rsp, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
	if err != nil {
		return fmt.Errorf("healthcheck: no answer on port %d", port)
	}
	defer rsp.Body.Close()
	var health struct {
		Status string `json:"status"`
	}
	if rsp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: HTTP %d on port %d", rsp.StatusCode, port)
	}
	if err := json.NewDecoder(io.LimitReader(rsp.Body, 1<<20)).Decode(&health); err != nil || health.Status != "ok" {
		return fmt.Errorf("healthcheck: not the health of a quoter on port %d", port)
	}
	return nil
}

// newLogger writes JSON lines as every quoter does: time in UTC with
// milliseconds, then level, msg and the fields.
func newLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey && len(groups) == 0 {
				return slog.String(a.Key, a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z07:00"))
			}
			return a
		},
	}))
}

// signalNames are the signals that stop the service, as the log names them.
var signalNames = map[os.Signal]string{syscall.SIGINT: "SIGINT", syscall.SIGTERM: "SIGTERM"}

func serve() error {
	cfg, err := config.Load(os.Getenv)
	// Langfuse half set is one more wrong variable, the last of the table
	_, _, lfErr := telemetry.FromEnv()
	if err := errors.Join(err, lfErr); err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	log := newLogger(os.Stdout)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	stopTracing, tracing, err := telemetry.Start(ctx, version)
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	defer func() {
		// a context of its own: ctx is done by now, and the last spans still go out
		flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := stopTracing(flush); err != nil {
			log.Warn("traces not flushed", "err", err)
		}
	}()

	engines, err := newEngines(cfg)
	if err != nil {
		return err
	}
	counter, err := prepare.NewCounter()
	if err != nil {
		return err
	}
	p := &pipeline.Pipeline{
		Engines:            engines,
		Counter:            counter,
		Catalog:            pricing.Default(),
		MaxInputTokens:     cfg.MaxInputTokens,
		GuardMinConfidence: cfg.GuardMinConfidence,
		JudgeThreshold:     cfg.JudgeThreshold,
		ReadAttempts:       cfg.ReadAttempts,
		RecountTimeout:     cfg.RecountTimeout,
		Prompts: map[string]string{
			"guard":    live.Version(pipeline.StageGuard),
			"parse":    live.ParseVersion(cfg.Engines == config.EnginesLive && cfg.Live.ParseIdentifies),
			"identify": live.Version(pipeline.StageIdentify),
			"judge":    live.Version(pipeline.StageJudge),
		},
	}
	if tracing {
		// each quote's measures, as scores on its trace
		lf, _, err := telemetry.FromEnv() // Start read it already: it is set and sound
		if err != nil {
			return fmt.Errorf("telemetry: %w", err)
		}
		scores := telemetry.NewScores(lf, log)
		p.Measured = scores.Quote
		defer func() {
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := scores.Close(flush); err != nil {
				log.Warn("scores not flushed", "err", err)
			}
		}()
	}
	srv := &http.Server{
		Addr: ":" + strconv.Itoa(cfg.Port),
		Handler: httpapi.New(httpapi.Config{
			Pipeline:       p,
			Version:        version,
			Tracing:        tracing,
			MaxBodyBytes:   cfg.MaxBodyBytes,
			RequestTimeout: cfg.RequestTimeout,
			Log:            log,
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// the request's own budget, and time to write the answer
		WriteTimeout: cfg.RequestTimeout + 5*time.Second,
		IdleTimeout:  60 * time.Second,
		ErrorLog:     slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	if engines.Name == config.EnginesFake {
		log.Warn("fake engines: deterministic stand-ins for tests, never in production",
			"latency", cfg.FakeLatency, "cpu_ms", cfg.FakeCPUMs)
	}
	// listening is said once the port takes connections
	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	failed := make(chan error, 1)
	go func() { failed <- srv.Serve(ln) }()
	log.Info("listening", "addr", srv.Addr, "version", version, "engines", engines.Name, "tracing", tracing,
		slog.Group("prompts", "guard", p.Prompts["guard"], "parse", p.Prompts["parse"],
			"identify", p.Prompts["identify"], "judge", p.Prompts["judge"]))
	var sig os.Signal
	select {
	case err := <-failed:
		return fmt.Errorf("listen: %w", err)
	case sig = <-signals:
	}
	stop()

	log.Info("shutting down", "signal", signalNames[sig])
	// requests under way get their own budget to finish
	drain, cancel := context.WithTimeout(context.Background(), cfg.RequestTimeout+5*time.Second)
	defer cancel()
	if err := srv.Shutdown(drain); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func newEngines(cfg config.Config) (pipeline.Engines, error) {
	if cfg.Engines == config.EnginesFake {
		return fake.NewWith(fake.Latency{Real: cfg.FakeLatency == "real", CPUMs: cfg.FakeCPUMs}), nil
	}
	return live.New(cfg.Live)
}
