"""The order of the stages, and the thresholds that decide."""

import asyncio
import base64
import dataclasses
import secrets
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Final

from delorean.cart import Line, Mention, title_key
from delorean.pipeline import rules
from delorean.pipeline.outcome import (
    Code,
    Copies,
    GuardVerdict,
    Judgement,
    Quote,
    Rejection,
    Report,
    StageUsage,
    Tokens,
)
from delorean.pipeline.ports import LOCAL, EngineError, Engines, Identification, Retry, Stage, Usage, Verdict
from delorean.prepare import TokenCounter, normalize
from delorean.pricing import Catalog
from delorean.telemetry import NoTracer, Observation, SpanKind, Trace, Tracer


@dataclass(frozen=True, slots=True)
class Request:
    """A cart to quote, and who asks, for the trace."""

    cart: str
    user_id: str | None = None
    session_id: str | None = None
    request_id: str | None = None
    respond: Callable[[Quote | Rejection | BaseException], object] | None = None
    """The response body an outcome is answered with — a quote, a refusal, a
    failure — which the trace shows as its output; plain data when unset."""


@dataclass(frozen=True, slots=True)
class Pipeline:
    """Reads carts into quotes. Safe for concurrent use: a reading keeps its
    state to itself.

        prepare → guard → parse ∥ recount → identify → judge → price
                          └──────── read again, told what failed ┘

    prepare and price are plain code and never call a model.
    """

    engines: Engines
    counter: TokenCounter
    catalog: Catalog
    max_input_tokens: int
    """Bounds a cart, counted once normalized."""
    guard_min_confidence: float
    """The least confidence of a valid verdict."""
    judge_threshold: float
    """The least worst score of a reading that is priced."""
    read_attempts: int = 3
    """The most readings of one cart, the first included: a reading the judge
    refuses is read again, told what failed."""
    recount_timeout: float | None = None
    """Seconds the recount has, a retry included (RECOUNT_TIMEOUT, 6 s in the
    service): past them the reading goes on without it (degraded). It is
    asked a second time when the first call failed in under half of them.
    None: the request's budget alone, and no retry."""
    tracer: Tracer = field(default_factory=NoTracer)
    prompts: Mapping[str, str] = field(default_factory=dict)
    """The version of each prompt file, for the trace."""

    async def quote(self, request: Request) -> Quote | Rejection:
        """Reads a cart and prices it, or says which stage refused it. An
        engine that fails, or answers out of its contract, raises
        EngineError."""
        started = time.perf_counter()
        run = _Run(id=_quote_id(), tracer=self.tracer)
        with self.tracer.trace(
            "quote",
            input=request.cart,
            user_id=request.user_id,
            session_id=request.session_id,
            tags=(f"quoter:{QUOTER}", f"engines:{self.engines.name}"),
        ) as trace:
            try:
                outcome = await self._read(run, request.cart)
            except BaseException as err:
                run.report.ms = _ms_since(started)
                if request.respond:
                    trace.output(request.respond(err))
                self._measure(trace, run, request, _failure(err))
                raise
            run.report.ms = _ms_since(started)
            run.report.trace_id = trace.trace_id
            trace.output(request.respond(outcome) if request.respond else _traced(outcome))
            self._measure(trace, run, request, outcome)
        return outcome

    def _measure(self, trace: Trace, run: _Run, request: Request, outcome: Quote | Rejection | str) -> None:
        """The quote's own measures, as the trace's metadata and scores:
        Langfuse aggregates observations, and averages scores. A refusal and a
        failure are measured too: what they cost is part of what a quote
        costs."""
        match outcome:
            case Quote():
                name = "priced"
            case Rejection():
                name = outcome.code.value
            case str():
                name = outcome
        metadata: dict[str, object] = {}
        if request.request_id:
            metadata["request_id"] = request.request_id
        if isinstance(outcome, Quote):  # a refusal has no quote
            metadata["quote_id"] = outcome.id
        metadata["outcome"] = name
        if run.readings:
            metadata["attempts"] = run.readings
        if isinstance(outcome, Quote):
            metadata["total_cents"] = outcome.price.total_cents
        if any(u.degraded for u in run.report.stages):
            metadata["degraded"] = Stage.RECOUNT.value
        metadata["prompts"] = dict(self.prompts)
        trace.annotate(metadata)
        trace.score("cost_usd", run.report.cost_usd)
        trace.score("latency_ms", run.report.ms)
        if run.readings:
            trace.score("attempts", run.readings)
        trace.score("outcome", name)

    async def _read(self, run: _Run, cart: str) -> Quote | Rejection:
        with run.stage(Stage.PREPARE) as stage:
            text = normalize(cart)
            tokens = self.counter.count(text)
            stage.done(LOCAL, {"tokens": tokens}, tokens=tokens)
        if not text:
            return run.reject(Code.EMPTY_CART, "The cart is empty.")
        if tokens > self.max_input_tokens:
            return run.reject(
                Code.TOO_LONG,
                f"The cart counts {tokens} tokens, the limit is {self.max_input_tokens}.",
                tokens=Tokens(count=tokens, max=self.max_input_tokens),
            )

        with run.stage(Stage.GUARD) as stage:
            answers, usage = await self.engines.guard.check(text)
            verdict = rules.guard_verdict(answers)
            stage.done(usage, verdict)
        if verdict.verdict != Verdict.VALID or verdict.confidence < self.guard_min_confidence:
            return self._guard_rejection(run, verdict)

        # read, and read again told what failed, up to read_attempts readings
        memory = _Memory()
        retry: Retry | None = None
        judgement: Judgement | None = None
        for attempt in range(1, self.read_attempts + 1):
            run.attempt = run.readings = attempt
            readings = await self._read_twice(run, text, retry, memory)
            if isinstance(readings, Rejection):
                return readings
            parsed, recounted = readings  # recounted None: degraded, no recount
            if recounted is not None and memory.recount is None:
                memory.recount = recounted
            if parsed.reading:
                reading, recount = await self._identify(run, memory, parsed.reading, recounted)
                judgement = await self._judge(run, memory, text, reading, recount)
                if judgement.score >= self.judge_threshold:
                    return self._price(run, reading, replace(judgement, attempts=attempt))
            else:
                # no film, past the first attempt: the text has not changed, the
                # model has. A failed attempt, not a refusal, with nothing to
                # identify or put to Jev: it misses every film asked for
                judgement = rules.NOTHING_READ
            failed = [f for f in judgement.findings if f.score < self.judge_threshold]
            retry = Retry(reading=parsed.answered, failed=failed)

        assert judgement is not None, "the first attempt is judged, or refused"
        return run.reject(
            Code.UNFAITHFUL_READING,
            "The judge does not hold the reading faithful to the text: "
            f"its worst score, {judgement.score:.2f}, is under {self.judge_threshold:.2f}.",
            judgement=replace(judgement, attempts=self.read_attempts),
        )

    async def _read_twice(
        self, run: _Run, text: str, retry: Retry | None, memory: _Memory
    ) -> tuple[_Parsed, list[Mention] | None] | Rejection:
        """The parse and the recount, side by side. The parse decides first:
        its failure, which cancels the recount; then its refusal, which waits
        for the recount and reports what both took. The recount's own failure
        decides nothing: the reading goes on without it (None).

        The recount reads blind: its input never changes between readings. The
        first one that succeeded is kept for the request (`memory.recount`):
        later readings are not given a new call, span or usage for it, and
        are counted against it. One left out is asked again at the next
        reading."""
        if memory.recount is not None:
            parsed = await self._parse(run, text, retry)
            return parsed if isinstance(parsed, Rejection) else (parsed, memory.recount)
        # both start before anything can cancel them: each opens its span
        beside = _Beside()
        parse = asyncio.create_task(self._parse(run, text, retry, beside))
        recount = asyncio.create_task(self._recount(run, text, beside))
        try:
            parsed = await parse
            if isinstance(parsed, Rejection):
                await asyncio.wait([recount])  # what it took is part of the refusal's report
                return parsed
            return parsed, await recount
        finally:
            # neither outlives the reading, and what became of them is decided
            # above: retrieved here, asyncio does not report them
            for task in (parse, recount):
                task.cancel()
            await asyncio.wait([parse, recount])
            for task in (parse, recount):
                if not task.cancelled():
                    task.exception()

    async def _parse(
        self, run: _Run, text: str, retry: Retry | None, beside: _Beside | None = None
    ) -> _Parsed | Rejection:
        """The parser's reading, told what failed when it reads again. Too
        many copies of a title is refused on any attempt: a safety limit,
        whichever reading crosses it. No film is refused on the first
        attempt; on a later one it is a failed attempt, the loop's to judge.
        `beside` tells the recount when the parse has settled, and whether it
        failed: then the recount no longer matters."""
        beside = beside or _Beside()
        try:
            with run.stage(Stage.PARSE) as stage:
                answered, usage = await self.engines.parser.read(text, retry)
                parsed = _Parsed(answered=answered, reading=rules.merge(answered))
                stage.done(usage, parsed.reading)
        except BaseException:
            beside.failed = True
            raise
        finally:
            beside.settled.set()
        # the refusal is the quote's, not the parse's: its span shows the reading
        if run.attempt == 1 and not parsed.reading:
            return run.reject(Code.NO_FILM, "The text names no film to buy.")
        if copies := rules.too_many_copies(parsed.reading):
            return run.reject(Code.QUANTITY_TOO_LARGE, _too_many(copies), copies=copies)
        return parsed

    async def _recount(self, run: _Run, text: str, beside: _Beside | None = None) -> list[Mention] | None:
        """The recounter's reading, merged: blind, never told what failed, so it
        stays a second opinion. It is compared, never refused: a recount over
        the copy limit fails the count check, if anything.

        A recount that fails as an engine does — unreachable, a refused key,
        an answer off its schema, its own time running out — does not fail the
        quote: None, the stage degraded — no count check, and the judge still
        the guard. Only a request that is over, or a parse that failed beside
        it, fails on it: then the recount's failure is a failure, as the
        parse's is. So is a failure that is no engine's, a bug: it is not
        swallowed, it fails the quote as it would from any stage. Whether it is
        degraded is decided once the parse has settled, so that it does not
        depend on which failed first."""
        beside = beside or _Beside.alone()
        with run.stage(Stage.RECOUNT) as stage:
            try:
                recounted, usage = await self._recount_within(text, beside)
            except _RecountError as failed:
                waiting = time.perf_counter()
                await beside.settled.wait()
                stage.waited = time.perf_counter() - waiting
                if beside.failed:
                    failed.error.usage = failed.usage
                    raise failed.error from None
                stage.degrade(failed.usage, failed.error)
                return None
            stage.done(usage, recounted)
        return recounted

    async def _recount_within(self, text: str, beside: _Beside) -> tuple[list[Mention], Usage]:
        """The recount within recount_timeout: a second time when the first
        call failed in under half of it — an answer off its schema comes
        quickly, a slow model does not get faster — with what is left; never
        when the parse beside it failed. The usage adds up both calls.
        Without recount_timeout, one call and no retry."""
        if self.recount_timeout is None:
            try:
                return await self._recount_once(text)
            except EngineError as err:
                raise _RecountError(err, _usage_of(err)) from err
        loop = asyncio.get_running_loop()
        started, budget = loop.time(), self.recount_timeout
        taken: Usage | None = None
        try:
            async with asyncio.timeout_at(started + budget):
                try:
                    return await self._recount_once(text)
                except EngineError as err:
                    taken = _usage_of(err)
                    if beside.failed or loop.time() - started >= budget / 2:
                        raise _RecountError(err, taken) from err
                try:
                    mentions, usage = await self._recount_once(text)
                except EngineError as err:
                    raise _RecountError(err, _added(taken, _usage_of(err))) from err
                return mentions, _added(taken, usage)
        except TimeoutError as err:
            raise _RecountError(EngineError("no answer in time"), taken or _UNKNOWN) from err

    async def _recount_once(self, text: str) -> tuple[list[Mention], Usage]:
        mentions, usage = await self.engines.recounter.read(text)
        try:
            return rules.merge(mentions), usage
        except EngineError as err:
            err.usage = err.usage or usage
            raise

    async def _identify(
        self, run: _Run, memory: _Memory, parsed: list[Mention], recounted: list[Mention] | None
    ) -> tuple[list[Line], list[Line] | None]:
        """Both readings' lines — the parse's alone without a recount —
        identifying only the titles no earlier attempt has, and none the parse
        gave a film to (PARSE_IDENTIFIES): an identification is never asked
        twice."""
        readings = [parsed] if recounted is None else [parsed, recounted]
        read = rules.films_read(*readings)
        unknown = [
            t
            for t in rules.distinct_titles(*readings)
            if title_key(t) not in memory.identified and title_key(t) not in read
        ]
        with run.stage(Stage.IDENTIFY) as stage:
            usage = None
            if unknown:
                identifications, usage = await self.engines.identifier.identify(unknown)
                memory.identified.update(rules.identified(unknown, identifications))
            elif self.engines.caches_identifications:
                stage.span.describe({"cache_hits": 0})
            known = {**memory.identified, **read}
            reading = rules.lines(parsed, known)
            recount = None if recounted is None else rules.lines(recounted, known)
            stage.done(usage, {"reading": reading, "recount": recount})
        return reading, recount

    async def _judge(
        self, run: _Run, memory: _Memory, text: str, reading: list[Line], recount: list[Line] | None
    ) -> Judgement:
        """The judgement of a reading. One an earlier attempt judged — the same
        lines, in any order — is not put to Jev again: a wrong reading Jev
        refuses two times in three must not get three throws. Only `count` is
        computed anew, against the recount kept for the request; without one
        (degraded) there is nothing to count against."""
        with run.stage(Stage.JUDGE) as stage:
            usage = None
            judged = memory.judged.get(rules.facts(reading))
            if judged is None:
                findings, usage = await self.engines.judge.judge(text, reading)
                judged = rules.Judged.of(rules.judged(findings, reading), reading)
                memory.judged[rules.facts(reading)] = judged
            counted = [] if recount is None else rules.count_findings(reading, recount)
            findings = [*judged.findings(reading), *counted]
            judgement = replace(rules.judgement(findings), attempts=run.attempt)
            stage.done(usage, judgement)
        return judgement

    def _price(self, run: _Run, reading: list[Line], judgement: Judgement) -> Quote:
        with run.stage(Stage.PRICE) as stage:
            price = self.catalog.price(reading)
            stage.done(LOCAL, {"total_cents": price.total_cents})
        return Quote(id=run.id, price=price, judgement=judgement, report=run.report, created_at=datetime.now(UTC))

    def _guard_rejection(self, run: _Run, verdict: GuardVerdict) -> Rejection:
        match verdict.verdict:
            case Verdict.INJECTION:
                code = Code.INJECTION
                detail = "The text tries to instruct the system instead of ordering films."
            case Verdict.VALID:
                code = Code.INVALID_REQUEST
                detail = (
                    "The guard is not confident enough that the text orders films: "
                    f"{verdict.confidence:.2f}, under {self.guard_min_confidence:.2f}."
                )
            case Verdict.INVALID:
                code = Code.INVALID_REQUEST
                detail = "The text does not order films: gibberish, a language not understood, or off topic."
        return run.reject(code, detail, guard=verdict)


def _too_many(copies: Copies) -> str:
    return (
        f"{rules.quoted(copies.title)} is asked in {copies.count} copies; a cart holds at most {copies.max} of a title."
    )


QUOTER: Final = "python"
"""This implementation, as the trace's tags and the usage name it."""

_SPAN_KINDS: dict[Stage, SpanKind] = {
    Stage.GUARD: "guardrail",
    Stage.PARSE: "chain",
    Stage.RECOUNT: "chain",
    Stage.IDENTIFY: "chain",
    Stage.JUDGE: "evaluator",
}
"""The type of each stage's observation in Langfuse's graph; prepare and price
are plain spans."""

_PER_ATTEMPT = frozenset({Stage.PARSE, Stage.RECOUNT, Stage.IDENTIFY, Stage.JUDGE})
"""The stages each attempt runs again: their spans say which attempt."""


@dataclass(slots=True)
class _Run:
    """One reading under way."""

    id: str
    tracer: Tracer
    report: Report = field(default_factory=Report)
    attempt: int = 1
    """The reading under way, 1 to read_attempts."""
    readings: int = 0
    """The readings made: 0 before the parse."""

    @contextmanager
    def stage(self, stage: Stage) -> Iterator[_Stage]:
        """Opens the span of a stage; the stage says what it took and produced
        with `done`, and is accounted for at the end of the block. A failed
        stage's span carries its engine's own error; the error leaves it
        naming the stage, as the root and the log show it."""
        started = time.perf_counter()
        kind = _SPAN_KINDS.get(stage, "span")
        metadata = {"attempt": self.attempt} if stage in _PER_ATTEMPT else None
        running: _Stage | None = None
        try:
            with self.tracer.span(stage, kind=kind, metadata=metadata) as span:
                running = _Stage(span)
                yield running
        except EngineError as err:
            err.stage = err.stage or stage
            # a failed stage ran too: a refusal beside it reports what it took
            waited = running.waited if running else 0.0
            self._account(stage, started + waited, err.usage or Usage(engine="unknown"), tokens=None)
            raise
        assert running is not None
        if not running.ended:
            raise RuntimeError(f"stage {stage} ended without saying what it took")
        self._account(
            stage,
            started + running.waited,  # its own time, not what it waited for
            running.usage or Usage(engine=LOCAL.engine),
            tokens=running.tokens,
            degraded=running.degraded,
        )

    def _account(
        self, stage: Stage, started: float, usage: Usage, *, tokens: int | None, degraded: bool = False
    ) -> None:
        self.report.record(
            StageUsage(
                stage=stage,
                engine=usage.engine,
                model=usage.model,
                calls=usage.calls,
                ms=_ms_since(started),
                cost_usd=usage.cost_usd,
                tokens=tokens,
                degraded=degraded,
            )
        )

    def reject(
        self,
        code: Code,
        detail: str,
        *,
        tokens: Tokens | None = None,
        guard: GuardVerdict | None = None,
        copies: Copies | None = None,
        judgement: Judgement | None = None,
    ) -> Rejection:
        return Rejection(
            code=code,
            detail=detail,
            report=self.report,
            tokens=tokens,
            guard=guard,
            copies=copies,
            judgement=judgement,
        )


@dataclass(slots=True)
class _Stage:
    span: Observation
    ended: bool = False
    usage: Usage | None = None
    tokens: int | None = None
    degraded: bool = False
    waited: float = 0.0
    """Seconds the stage spent waiting for another, not on its own work."""

    def done(self, usage: Usage | None, output: object, *, tokens: int | None = None) -> None:
        """What the stage took — None when it called no engine, reusing what an
        earlier attempt learnt — and what it produced."""
        self.ended, self.usage, self.tokens = True, usage, tokens
        self.span.output(_traced(output))
        if usage and usage.cache_hits is not None:
            self.span.describe({"cache_hits": usage.cache_hits})

    def degrade(self, usage: Usage, error: EngineError) -> None:
        """The stage failed but the quote goes on without it: what it took,
        and a warning in its span, not an error."""
        self.ended, self.usage, self.degraded = True, usage, True
        self.span.warn(error)


@dataclass(frozen=True, slots=True)
class _Parsed:
    """One parse: the mentions as the parser answered them, and the reading
    they make once merged."""

    answered: list[Mention]
    reading: list[Mention]


@dataclass(slots=True)
class _Memory:
    """What the earlier attempts of one request learnt, so that none is asked
    twice: identifications by title key, the judge's findings by reading."""

    identified: dict[str, Identification] = field(default_factory=dict)
    judged: dict[frozenset[rules.Fact], rules.Judged] = field(default_factory=dict)
    recount: list[Mention] | None = None
    """The first recount that succeeded, merged: kept for every later reading."""


@dataclass(slots=True)
class _Beside:
    """The parse beside a recount: whether it has settled, and failed."""

    settled: asyncio.Event = field(default_factory=asyncio.Event)
    failed: bool = False

    @classmethod
    def alone(cls) -> _Beside:
        """A recount with no parse beside it: nothing to wait for."""
        beside = cls()
        beside.settled.set()
        return beside


class _RecountError(Exception):
    """The recount's failure, with what its calls took: the quote goes on
    without it."""

    def __init__(self, error: EngineError, usage: Usage) -> None:
        super().__init__(str(error))
        self.error, self.usage = error, usage


_UNKNOWN: Final = Usage(engine="unknown")
"""What a call took when its engine could not say."""


def _usage_of(error: EngineError) -> Usage:
    return error.usage or _UNKNOWN


def _added(first: Usage | None, then: Usage) -> Usage:
    """Two calls of one stage as one usage: calls and cost add up."""
    if first is None:
        return then
    return Usage(
        engine=first.engine if first.engine != _UNKNOWN.engine else then.engine,
        model=first.model or then.model,
        calls=first.calls + then.calls,
        cost_usd=first.cost_usd + then.cost_usd,
    )


def _failure(error: BaseException) -> str:
    """The problem code a failure is answered with: an engine that failed, or
    did not answer in time, is unavailable; anything else is a bug."""
    if isinstance(error, EngineError | asyncio.CancelledError | TimeoutError):
        return "engine_unavailable"
    return "internal"


def _quote_id() -> str:
    """A quote's id: q_ and 16 random base32 characters, 80 bits."""
    return "q_" + base64.b32encode(secrets.token_bytes(10)).decode().lower()


def _ms_since(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _traced(value: object) -> object:
    """value as a trace shows it, the shapes every quoter gives it: plain
    data, a refusal as its code and detail, the guard's verdict as the
    contract's GuardOutcome, a mention without film without `film`."""
    match value:
        case Rejection(code=code, detail=detail):
            return {"code": code, "detail": detail}
        case GuardVerdict():
            return {
                "verdict": value.verdict,
                "confidence": value.confidence,
                "probabilities": dict(value.probabilities),
                "questions": {"order": value.answers.order, "steer": value.answers.steer},
            }
        case Judgement():
            findings = [{"check": f.check, "label": f.label, "score": f.score} for f in value.findings]
            return {"score": value.score, "findings": findings, "attempts": value.attempts}
        case Mention():
            mention: dict[str, object] = {"title": value.title, "quantity": value.quantity}
            if value.film is not None:
                mention["film"] = value.film
            return mention
        case Quote(id=quote_id, price=price):
            lines = [
                {
                    **dataclasses.asdict(p.line),
                    "unit_cents": p.unit_cents,
                    "subtotal_cents": p.subtotal_cents,
                }
                for p in price.lines
            ]
            return {"id": quote_id, "lines": lines, "total_cents": price.total_cents}
        case list() | tuple():
            return [_traced(v) for v in value]
        case dict():
            return {k: _traced(v) for k, v in value.items()}
        case _ if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return dataclasses.asdict(value)
    return value
