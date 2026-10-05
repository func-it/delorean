"""What the tests share: the tokenizer, the prompts, and a pipeline on the
fake engines. No test calls a model: the live engines are tested against
recorded answers, on mock transports."""

import json
import os
import socket
import uuid
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from delorean.config import REPO_DIR, tokenizer_dir
from delorean.engines import fake
from delorean.pipeline import Pipeline
from delorean.prepare import TokenCounter
from delorean.pricing import DEFAULT_CATALOG
from delorean.prompts import Prompts, load_prompts
from delorean.telemetry import LangfuseTracer

PROMPTS_DIR = REPO_DIR / "prompts"
TINY_PROMPTS_DIR = Path(__file__).parent / "fixtures" / "prompts"
"""A prompt set of a few words: the tests of what the engines assemble use it,
so that no test copies the production wording, which lives in prompts/ only."""
CONTRACT = REPO_DIR / "api" / "openapi.yaml"


_LOCAL: frozenset[str | None] = frozenset({None, "localhost", "127.0.0.1", "::1"})


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """The suite never reaches beyond the machine: a name that is not local is not looked up, and a
    connection to another address is refused, so that a test that would go to the network fails loudly
    (the tokenizer's vocabulary is fetched by `delorean tokenizer`, apart, not by a test)."""
    connect = socket.socket.connect
    lookup = socket.getaddrinfo

    def guarded_connect(self: socket.socket, address: Any) -> None:
        host = address[0] if isinstance(address, tuple) else None
        if host not in _LOCAL:
            raise OSError(f"a test went to the network: {address!r}")
        connect(self, address)

    def guarded_lookup(host: Any, *args: Any, **kwargs: Any) -> Any:
        name = host.decode() if isinstance(host, bytes) else host
        if name not in _LOCAL:
            raise socket.gaierror(f"a test went to the network: {name!r}")
        return lookup(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_lookup)


@pytest.fixture(scope="session")
def counter() -> TokenCounter:
    return TokenCounter.load(tokenizer_dir(os.environ))


@pytest.fixture(scope="session")
def prompts() -> Prompts:
    return load_prompts(PROMPTS_DIR)


@pytest.fixture
def pipeline(counter: TokenCounter) -> Pipeline:
    """A pipeline on the fake engines and the default rules; a test changes
    what it needs with dataclasses.replace."""
    return Pipeline(
        engines=fake.engines(),
        counter=counter,
        catalog=DEFAULT_CATALOG,
        max_input_tokens=2048,
        guard_min_confidence=0.5,
        judge_threshold=0.5,
    )


class Spans:
    """A Langfuse tracer whose spans stay in memory, and whose scores are
    received by a stub ingestion API, for a test to read."""

    def __init__(self) -> None:
        self.exporter = InMemorySpanExporter()
        self.batches: list[dict[str, Any]] = []
        # Langfuse keeps one client per public key: one key per test
        self.tracer = LangfuseTracer(
            public_key=f"pk-test-{uuid.uuid4()}",
            secret_key="sk-test",
            base_url="http://localhost:9",
            version="test",
            exporter=self.exporter,
            scores=httpx.MockTransport(self._ingest),
        )

    def _ingest(self, request: httpx.Request) -> httpx.Response:
        self.batches.append(json.loads(request.content))
        return httpx.Response(207, json={"successes": [], "errors": []})

    def ended(self) -> list[ReadableSpan]:
        self.tracer.flush_spans()
        return list(self.exporter.get_finished_spans())

    def named(self, name: str) -> ReadableSpan:
        return next(s for s in self.ended() if s.name == name)

    def attributes(self, name: str) -> dict[str, Any]:
        return dict(self.named(name).attributes or {})

    async def scores(self) -> list[dict[str, Any]]:
        """The bodies of the scores sent so far."""
        await self.tracer.flush_scores()
        return [event["body"] for batch in self.batches for event in batch["batch"]]

    async def scored(self) -> dict[str, object]:
        return {score["name"]: score["value"] for score in await self.scores()}


@pytest.fixture
async def spans() -> AsyncIterator[Spans]:
    recorded = Spans()
    yield recorded
    await recorded.tracer.shutdown()


@pytest.fixture
def traced(pipeline: Pipeline, spans: Spans) -> Pipeline:
    return replace(pipeline, tracer=spans.tracer)


def repo_path(*parts: str) -> Path:
    return REPO_DIR.joinpath(*parts)
