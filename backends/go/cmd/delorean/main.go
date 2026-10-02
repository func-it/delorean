// delorean prices a free-text DVD cart with the Back to the Future promotion:
// models read the cart, code computes the price.
//
//	delorean [serve]   the HTTP API (api/openapi.yaml), configured by the environment
//	delorean version   the version of this build
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/bn-k/delorean/backends/go/internal/config"
	"github.com/bn-k/delorean/backends/go/internal/fake"
	"github.com/bn-k/delorean/backends/go/internal/httpapi"
	"github.com/bn-k/delorean/backends/go/internal/live"
	"github.com/bn-k/delorean/backends/go/internal/pipeline"
	"github.com/bn-k/delorean/backends/go/internal/prepare"
	"github.com/bn-k/delorean/backends/go/internal/pricing"
	"github.com/bn-k/delorean/backends/go/internal/telemetry"
)

// version is set at build time: -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "delorean:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "serve":
		return serve()
	case "version":
		fmt.Println(version)
		return nil
	}
	return fmt.Errorf("unknown command %q: want serve or version", cmd)
}

func serve() error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	stopTracing, tracing, err := telemetry.Start(ctx)
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

	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServe() }()
	log.Info("listening", "addr", srv.Addr, "version", version, "engines", engines.Name, "tracing", tracing)
	if engines.Name == config.EnginesFake {
		log.Warn("fake engines: deterministic stand-ins for tests, never in production")
	}
	select {
	case err := <-failed:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}

	log.Info("shutting down")
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
		return fake.New(), nil
	}
	return live.New(cfg.Live)
}
