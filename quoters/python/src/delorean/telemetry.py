"""Traces to Langfuse when it is configured, and nothing otherwise.

Code that traces holds a Tracer and never asks whether tracing is on: the
NoTracer answers every call with an observation that records nothing. The
LangfuseTracer is the Langfuse SDK (OpenTelemetry underneath) on a tracer
provider of its own: nothing else in the process exports to Langfuse, and the
global OpenTelemetry state is left alone.

A trace has the shape all three quoters give it (docs/architecture.md,
"Usage, cost and traces" and "Identical quoters"): named `quote`, with the
user, the session and the tags on every observation; the metadata on the
root only; an `agent` root; one observation per stage, typed for Langfuse's
graph; one generation per model call, with its tokens and cost; and the
quote's own measures as scores, sent by this module to the ingestion API so
that their failures are logged in the quoters' words.
"""

import asyncio
import base64
import contextlib
import logging
import os
from collections.abc import Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager
from datetime import UTC, datetime
from typing import Any, Final, Literal, Protocol, override

import httpx
from langfuse import Langfuse, LangfuseOtelSpanAttributes, propagate_attributes
from langfuse import __version__ as langfuse_version
from opentelemetry import trace as otel_trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

from delorean.jsontext import dumps, timestamp

type SpanKind = Literal["span", "chain", "guardrail", "evaluator"]

log = logging.getLogger("delorean.telemetry")


class Observation(Protocol):
    """A span under way: what it produced, or how it failed."""

    def output(self, value: object) -> None: ...

    def describe(self, metadata: Mapping[str, object]) -> None:
        """Metadata of the span learnt on the way, added to what it had."""
        ...

    def fail(self, error: BaseException) -> None: ...


class Generation(Observation, Protocol):
    """One model call."""

    def usage(self, *, input_tokens: int, output_tokens: int, cost_usd: float) -> None: ...


class Trace(Observation, Protocol):
    @property
    def trace_id(self) -> str | None:
        """The id of the trace, when it is exported."""
        ...

    def annotate(self, metadata: Mapping[str, object]) -> None:
        """The trace's metadata, on its root alone: numbers stay numbers,
        structures are compact JSON."""
        ...

    def score(self, name: str, value: float | str) -> None:
        """A score of the trace, numeric or categorical for a string, sent
        once the trace ends."""
        ...


class Tracer(Protocol):
    @property
    def enabled(self) -> bool: ...

    def trace(
        self,
        name: str,
        *,
        input: str,
        user_id: str | None = None,
        session_id: str | None = None,
        tags: Sequence[str] = (),
    ) -> AbstractContextManager[Trace]:
        """A trace and its root observation, an agent, both called `name`,
        reading `input`."""
        ...

    def span(
        self, name: str, *, kind: SpanKind = "span", metadata: Mapping[str, object] | None = None
    ) -> AbstractContextManager[Observation]:
        """A span under the current one."""
        ...

    def generation(
        self, name: str, *, model: str, input: object, parameters: Mapping[str, str] | None = None
    ) -> AbstractContextManager[Generation]:
        """A model call under the current span."""
        ...

    async def shutdown(self) -> None:
        """Sends what is left, and stops."""
        ...


class _Nothing:
    """An observation that records nothing."""

    trace_id = None

    def output(self, value: object) -> None:
        pass

    def describe(self, metadata: Mapping[str, object]) -> None:
        pass

    def fail(self, error: BaseException) -> None:
        pass

    def usage(self, *, input_tokens: int, output_tokens: int, cost_usd: float) -> None:
        pass

    def annotate(self, metadata: Mapping[str, object]) -> None:
        pass

    def score(self, name: str, value: float | str) -> None:
        pass


class NoTracer:
    """Tracing off: every span is a no-op."""

    enabled = False

    @contextmanager
    def trace(
        self,
        name: str,  # noqa: ARG002
        *,
        input: str,  # noqa: ARG002
        user_id: str | None = None,  # noqa: ARG002
        session_id: str | None = None,  # noqa: ARG002
        tags: Sequence[str] = (),  # noqa: ARG002
    ) -> Iterator[Trace]:
        yield _Nothing()

    @contextmanager
    def span(
        self,
        name: str,  # noqa: ARG002
        *,
        kind: SpanKind = "span",  # noqa: ARG002
        metadata: Mapping[str, object] | None = None,  # noqa: ARG002
    ) -> Iterator[Observation]:
        yield _Nothing()

    @contextmanager
    def generation(
        self,
        name: str,  # noqa: ARG002
        *,
        model: str,  # noqa: ARG002
        input: object,  # noqa: ARG002
        parameters: Mapping[str, str] | None = None,  # noqa: ARG002
    ) -> Iterator[Generation]:
        yield _Nothing()

    async def shutdown(self) -> None:
        pass


class _Observed(Protocol):
    """What the tracer uses of a Langfuse observation."""

    @property
    def trace_id(self) -> str: ...

    def update(self, **fields: Any) -> object: ...


class _Recorded:
    """An observation that Langfuse records."""

    def __init__(self, observed: _Observed) -> None:
        self._observed = observed
        # the observation is the current span while its block runs
        self._span = otel_trace.get_current_span()

    @property
    def trace_id(self) -> str | None:
        return self._observed.trace_id

    def output(self, value: object) -> None:
        self._observed.update(output=_text(value))

    def describe(self, metadata: Mapping[str, object]) -> None:
        self._observed.update(metadata=dict(metadata))

    def fail(self, error: BaseException) -> None:
        """Level ERROR, the error's message as the status message, and an
        exception event that carries it too."""
        message = str(error) or type(error).__name__
        self._observed.update(level="ERROR", status_message=message)
        self._span.record_exception(error, attributes={"exception.message": message})

    def usage(self, *, input_tokens: int, output_tokens: int, cost_usd: float) -> None:
        # no count, no details: a 0 would read as a free call
        tokens = {"input": input_tokens, "output": output_tokens} if input_tokens or output_tokens else None
        self._observed.update(usage_details=tokens, cost_details={"total": cost_usd})


class _RecordedTrace(_Recorded):
    """The root of a trace: the trace's own input, output, metadata and
    scores, which the root alone carries."""

    def __init__(self, observed: _Observed) -> None:
        super().__init__(observed)
        self.scores: list[tuple[str, float | str]] = []

    @override
    def output(self, value: object) -> None:
        super().output(value)
        self._span.set_attribute(LangfuseOtelSpanAttributes.TRACE_OUTPUT, _text(value))

    def annotate(self, metadata: Mapping[str, object]) -> None:
        for key, value in metadata.items():
            attribute = value if isinstance(value, bool | int | float | str) else dumps(value)
            self._span.set_attribute(f"{LangfuseOtelSpanAttributes.TRACE_METADATA}.{key}", attribute)

    def score(self, name: str, value: float | str) -> None:
        self.scores.append((name, value))


class LangfuseTracer:
    """Tracing on: spans go to a Langfuse project, scores to its ingestion
    API."""

    enabled = True

    def __init__(
        self,
        *,
        public_key: str,
        secret_key: str,
        base_url: str,
        version: str,
        exporter: SpanExporter | None = None,
        scores: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """exporter replaces the export of spans to base_url, scores the
        transport of the scores: tests read them there."""
        auth = "Basic " + base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        self._exporter = _Watched(
            exporter
            or OTLPSpanExporter(
                endpoint=f"{base_url.rstrip('/')}/api/public/otel/v1/traces",
                headers={
                    "Authorization": auth,
                    "x-langfuse-sdk-name": "python",
                    "x-langfuse-sdk-version": langfuse_version,
                    "x-langfuse-public-key": public_key,
                },
            )
        )
        self._provider = TracerProvider(
            resource=Resource.create({"service.name": "delorean", "service.version": version})
        )
        self._langfuse = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            base_url=base_url,
            tracer_provider=self._provider,
            span_exporter=self._exporter,
        )
        # The release is LANGFUSE_RELEASE's, as in every quoter, never one the
        # SDK guesses from a CI's variables (GITHUB_SHA…): the SDK has no switch
        # for that guess, so the client's own value is set over it
        self._langfuse._release = os.environ.get("LANGFUSE_RELEASE") or None
        self._scores = _Scores(base_url=base_url, auth=auth, transport=scores)

    @contextmanager
    def trace(
        self,
        name: str,
        *,
        input: str,
        user_id: str | None = None,
        session_id: str | None = None,
        tags: Sequence[str] = (),
    ) -> Iterator[Trace]:
        root: _RecordedTrace | None = None
        try:
            # the attributes first: they reach only the spans opened after them
            with (
                propagate_attributes(trace_name=name, user_id=user_id, session_id=session_id, tags=list(tags)),
                self._observing(
                    self._langfuse.start_as_current_observation(name=name, as_type="agent", input=input),
                    _RecordedTrace,
                ) as root,
            ):
                otel_trace.get_current_span().set_attribute(LangfuseOtelSpanAttributes.TRACE_INPUT, input)
                yield root
        finally:
            # a failure is scored too: what it cost is part of what a quote costs
            if root is not None and root.trace_id and root.scores:
                self._scores.send(root.trace_id, root.scores)

    @contextmanager
    def span(
        self, name: str, *, kind: SpanKind = "span", metadata: Mapping[str, object] | None = None
    ) -> Iterator[Observation]:
        with self._observing(
            self._langfuse.start_as_current_observation(name=name, as_type=kind, metadata=metadata), _Recorded
        ) as span:
            yield span

    @contextmanager
    def generation(
        self, name: str, *, model: str, input: object, parameters: Mapping[str, str] | None = None
    ) -> Iterator[Generation]:
        observation = self._langfuse.start_as_current_observation(
            name=name,
            as_type="generation",
            model=model,
            input=_text(input),
            model_parameters=dict(parameters) if parameters else None,
        )
        with self._observing(observation, _Recorded) as generation:
            yield generation

    @staticmethod
    @contextmanager
    def _observing[R: _Recorded](observation: AbstractContextManager[Any], record: type[R]) -> Iterator[R]:
        """An observation's block. A failure is recorded with its message as
        it is, and leaves the SDK's block as a normal exit: OpenTelemetry would
        write `<Type>: <message>` over it. A cancelled request is no error."""
        failure: BaseException | None = None
        with observation as observed:
            recorded = record(observed)
            try:
                yield recorded
            except BaseException as err:  # noqa: BLE001 — recorded here, raised below
                failure = err
                if not isinstance(err, asyncio.CancelledError):
                    recorded.fail(err)
        if failure is not None:
            raise failure

    def flush_spans(self) -> None:
        """Exports the spans ended so far."""
        self._langfuse.flush()

    async def flush_scores(self) -> None:
        """Waits for the scores queued so far to be sent."""
        await self._scores.drain()

    async def shutdown(self) -> None:
        await self._scores.close()
        flushed = await asyncio.to_thread(self._provider.force_flush, 5_000)
        if not flushed or self._exporter.failure:
            log.warning("traces not flushed", extra={"err": self._exporter.failure or "timeout"})
        await asyncio.to_thread(self._langfuse.shutdown)


class _Watched(SpanExporter):
    """An exporter that remembers its last failure, for the shutdown's log."""

    def __init__(self, exporter: SpanExporter) -> None:
        self._exporter = exporter
        self.failure: str | None = None

    @override
    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        try:
            result = self._exporter.export(spans)
        except Exception as err:  # noqa: BLE001 — an exporter must not raise; one that does failed
            self.failure = str(err) or type(err).__name__
            return SpanExportResult.FAILURE
        self.failure = None if result is SpanExportResult.SUCCESS else f"{len(spans)} spans not exported"
        return result

    @override
    def shutdown(self) -> None:
        self._exporter.shutdown()

    @override
    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._exporter.force_flush(timeout_millis)


QUEUE: Final = 1_000
"""The most traces whose scores wait to be sent; past it, they are dropped."""


class _Scores:
    """The traces' scores, sent in the background, a batch per trace, to
    /api/public/ingestion. A score's id is `<trace id>-<name>`: sending it
    again replaces it."""

    def __init__(self, *, base_url: str, auth: str, transport: httpx.AsyncBaseTransport | None) -> None:
        self._url = f"{base_url.rstrip('/')}/api/public/ingestion"
        self._auth = auth
        self._transport = transport
        self._queue: asyncio.Queue[tuple[str, list[tuple[str, float | str]]]] = asyncio.Queue(QUEUE)
        self._worker: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._environment = os.environ.get("LANGFUSE_TRACING_ENVIRONMENT") or None

    def send(self, trace_id: str, scores: list[tuple[str, float | str]]) -> None:
        if self._worker is None:
            self._client = httpx.AsyncClient(timeout=10, transport=self._transport)
            self._worker = asyncio.get_running_loop().create_task(self._work())
        try:
            self._queue.put_nowait((trace_id, scores))
        except asyncio.QueueFull:
            log.warning("langfuse scores dropped, the queue is full", extra={"trace_id": trace_id})

    async def _work(self) -> None:
        while True:
            trace_id, scores = await self._queue.get()
            try:
                await self._post(trace_id, scores)
            except Exception as err:  # noqa: BLE001 — a score not sent is logged, never raised
                log.warning("langfuse scores not sent", extra={"trace_id": trace_id, "err": str(err)})
            finally:
                self._queue.task_done()

    async def _post(self, trace_id: str, scores: list[tuple[str, float | str]]) -> None:
        assert self._client is not None
        now = timestamp(datetime.now(UTC))
        batch = [
            {
                # the score's own id: Langfuse drops an event it has seen, so a
                # batch sent again changes nothing
                "id": f"{trace_id}-{name}",
                "type": "score-create",
                "timestamp": now,
                "body": {
                    "id": f"{trace_id}-{name}",
                    "traceId": trace_id,
                    "name": name,
                    "value": value,
                    "dataType": "CATEGORICAL" if isinstance(value, str) else "NUMERIC",
                    **({"environment": self._environment} if self._environment else {}),
                },
            }
            for name, value in scores
        ]
        response = await self._client.post(
            self._url,
            content=dumps({"batch": batch}),
            headers={"Authorization": self._auth, "Content-Type": "application/json"},
        )
        if response.status_code >= 300:
            raise RuntimeError(f"status {response.status_code}")
        errors = response.json().get("errors") if response.status_code == 207 else None
        if errors:
            raise RuntimeError(f"{len(errors)} scores refused: {errors[0].get('message', '')}")

    async def drain(self) -> None:
        if self._worker is not None:
            await self._queue.join()

    async def close(self) -> None:
        """Sends what waits, a few seconds at most."""
        if self._worker is None:
            return
        try:
            async with asyncio.timeout(5):
                await self._queue.join()
        except TimeoutError:
            log.warning("scores not flushed", extra={"err": f"{self._queue.qsize()} traces' scores waiting"})
        self._worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._worker
        if self._client is not None:
            await self._client.aclose()


def _text(value: object) -> object:
    """What an observation shows: a string as it is, anything else in the
    quoters' compact JSON."""
    return value if isinstance(value, str) else dumps(value)
