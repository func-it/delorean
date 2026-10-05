"""delorean prices a free-text DVD cart with the Back to the Future promotion.

delorean [serve]    the HTTP API (api/openapi.yaml), configured by the environment
delorean version    the version of this build
delorean tokenizer  make the tokenizer's vocabulary available offline, once
"""

import asyncio
import json
import logging
import os
import signal
import socket
import sys
from collections.abc import Callable, Mapping
from types import FrameType
from typing import override

import uvicorn

from delorean import logs, prepare
from delorean.api.app import Service, create_app
from delorean.config import ConfigError, Settings, tokenizer_dir
from delorean.engines import open_engines
from delorean.pipeline import Pipeline
from delorean.pricing import DEFAULT_CATALOG
from delorean.prompts import PromptError, Prompts, load_prompts
from delorean.telemetry import LangfuseTracer, NoTracer, Tracer

COMMANDS = ("serve", "version", "tokenizer")

log = logging.getLogger("delorean")


def version() -> str:
    """The build's version: DELOREAN_VERSION, which the Docker image and the
    tasks set to `git describe`, or dev."""
    return os.environ.get("DELOREAN_VERSION") or "dev"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    command = args[0] if args else "serve"
    if command not in COMMANDS:
        return _usage(f"unknown command {_quoted(command)}: want serve, version or tokenizer")
    if len(args) > 1:
        return _usage(f"unexpected argument {_quoted(args[1])}")
    try:
        match command:
            case "serve":
                logs.configure()
                # SIGTERM stops the service as SIGINT does. uvicorn drains the
                # requests under way on either, then raises the signal again:
                # this way the process ends cleanly, the last spans sent
                signal.signal(signal.SIGTERM, _interrupt)
                asyncio.run(serve(Settings.from_env(os.environ)))
            case "version":
                print(version())
            case "tokenizer":
                path = prepare.fetch_vocabulary(tokenizer_dir(os.environ))
                print(f"{prepare.ENCODING}: {prepare.ranks(path)} ranks")
    except ConfigError as err:
        print(f"delorean: configuration:\n{err}", file=sys.stderr)
        return 1
    except (PromptError, prepare.TokenizerMissingError) as err:
        print(f"delorean: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        pass
    return 0


def _usage(problem: str) -> int:
    print(f"delorean: {problem}", file=sys.stderr)
    return 2


def _quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _interrupt(signum: int, frame: FrameType | None) -> None:  # noqa: ARG001
    raise KeyboardInterrupt


def served(prompts: Prompts, *, parse_identifies: bool) -> dict[str, str]:
    """The versions of the prompts the quoter runs, as /healthz serves them:
    the parse's file is parse-films.json when the parse identifies."""
    return {
        "guard": prompts.versions["guard"],
        "parse": prompts.versions["parse-films" if parse_identifies else "parse"],
        "identify": prompts.versions["identify"],
        "judge": prompts.versions["judge"],
    }


async def serve(settings: Settings) -> None:
    """Serves until SIGINT or SIGTERM; requests under way get their budget to
    finish."""
    prompts = load_prompts(settings.prompts_dir)
    versions = served(prompts, parse_identifies=settings.live.parse_identifies)
    counter = prepare.TokenCounter.load(settings.tokenizer_dir)
    tracer: Tracer = NoTracer()
    if lf := settings.langfuse:
        tracer = LangfuseTracer(
            public_key=lf.public_key, secret_key=lf.secret_key, base_url=lf.base_url, version=version()
        )
    try:
        async with open_engines(settings, prompts, tracer) as engines:
            pipeline = Pipeline(
                engines=engines,
                counter=counter,
                catalog=DEFAULT_CATALOG,
                max_input_tokens=settings.max_input_tokens,
                guard_min_confidence=settings.guard_min_confidence,
                judge_threshold=settings.judge_threshold,
                read_attempts=settings.read_attempts,
                recount_timeout=settings.recount_timeout,
                tracer=tracer,
                prompts=versions,
            )
            app = create_app(
                Service(
                    pipeline=pipeline,
                    version=version(),
                    tracing=tracer.enabled,
                    prompts=versions,
                    max_body_bytes=settings.max_body_bytes,
                    request_timeout=settings.request_timeout,
                )
            )
            server = _Server(
                lambda: _listening(settings.port, engines.name, tracing=tracer.enabled, prompts=versions),
                uvicorn.Config(
                    app,
                    host="0.0.0.0",
                    port=settings.port,
                    log_config=None,  # logs.configure's JSON lines
                    access_log=False,  # the API logs each request itself
                    server_header=False,
                    timeout_graceful_shutdown=int(settings.request_timeout) + 5,
                ),
            )
            if engines.name == "fake":
                log.warning(
                    "fake engines: deterministic stand-ins for tests, never in production",
                    extra={"latency": settings.fake_latency, "cpu_ms": settings.fake_cpu_ms},
                )
            await server.serve()
    finally:
        # the last spans and scores still go out
        await tracer.shutdown()


def _listening(port: int, engines: str, *, tracing: bool, prompts: Mapping[str, str]) -> None:
    log.info(
        "listening",
        extra={"addr": f":{port}", "version": version(), "engines": engines, "tracing": tracing, "prompts": prompts},
    )


class _Server(uvicorn.Server):
    """uvicorn's server, which says when it listens — once its socket is
    bound: listening means ready — and, once, why it stops."""

    stopping = False

    def __init__(self, listening: Callable[[], None], config: uvicorn.Config) -> None:
        super().__init__(config)
        self._listening = listening

    @override
    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets)
        if self.started:
            self._listening()

    @override
    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        if not self.stopping:
            self.stopping = True
            log.info("shutting down", extra={"signal": signal.Signals(sig).name})
        super().handle_exit(sig, frame)


if __name__ == "__main__":
    sys.exit(main())
