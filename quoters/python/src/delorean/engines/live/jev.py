"""Jev, TypeSafe's System One model: typed questions about a state, answered
with calibrated probabilities, never prose. Reached through OpenRouter's
decisions endpoint, not chat/completions, and the only road to Jev in
delorean.

A question is the whole prompt — its instructions and the description of each
option — and comes from prompts/: quality is tuned there, never here.
"""

import asyncio
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Final

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from delorean.pipeline import EngineError, Usage
from delorean.pipeline.ports import note_cut
from delorean.prompts import Question
from delorean.tasks import all_of
from delorean.telemetry import Tracer

JEV_URL: Final = "https://openrouter.ai/api/alpha/decisions"
JEV_MODEL: Final = "typesafe/jev-1.13"
"""The version of Jev delorean is tuned on, frozen."""
HEADERS: Final = {"HTTP-Referer": "https://github.com/func-it/delorean", "X-Title": "delorean"}
"""How OpenRouter tells delorean's calls apart."""

IN_FLIGHT: Final = 16
"""The most requests one set keeps open at once: a long cart is hundreds of
independent questions, and OpenRouter caps Jev's rate."""
MAX_ANSWER_BYTES: Final = 256 << 10
TRANSIENT: Final = frozenset({429, 500, 502, 503, 504, 520, 522, 524, 529})
"""Statuses worth waiting out: OpenRouter caps Jev's rate (429), Jev answers
529 when overloaded and 5xx on a reset, the Cloudflare in front 520-524."""


@dataclass(frozen=True, slots=True)
class Ask:
    """One request: every key of `state` is a document Jev reads, named for
    what it is. Questions put in one request are answered together — and
    colour one another: put independent judgements in separate requests."""

    state: Mapping[str, str]
    questions: Sequence[Question]


@dataclass(frozen=True, slots=True)
class Answer:
    """One question's answer: `noul` for a noul, `choice` and
    `probabilities` for a choice."""

    noul: float = 0.0
    choice: str = ""
    confidence: float = 0.0
    probabilities: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Decision:
    """Every answer of one request, and what it took."""

    answers: Mapping[str, Answer]
    id: str
    """The upstream decision id, for audit."""
    engine: str
    model: str
    cost_usd: float
    input_tokens: int = 0
    output_tokens: int = 0
    """The tokens as the engine reports them; 0 when it reports none."""


class JevError(EngineError):
    def __init__(self, message: str, *, status: int | None = None, transient: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.transient = transient


class _Wire(BaseModel):
    """Jev's answer as it comes, held to its types: a number is a number."""

    model_config = ConfigDict(strict=True)


class _Answer(_Wire):
    noul: float = 0.0
    choice: str = ""
    confidence: float = 0.0
    probabilities: dict[str, float] = {}


class _Usage(_Wire):
    cost: float = 0.0
    # the token counts, under either spelling OpenRouter uses
    input_tokens: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0
    completion_tokens: int = 0


class _Error(_Wire):
    message: str = ""


class _Response(_Wire):
    id: str = ""
    answers: dict[str, _Answer] = {}
    usage: _Usage = _Usage()
    error: _Error | None = None


class Jev:
    """Jev over HTTP: POST {model, state, questions}, answered with {id,
    answers, usage}.

    `attempts` above 1 waits out transient failures, `wait` seconds apart,
    doubled each time; at 1, the default, a failure is an EngineError at once:
    in the request path a customer is waiting. `timeout` bounds a whole call,
    connecting, sending and reading the answer (MODEL_TIMEOUT): not the time of
    each phase, which a slow trickle never exceeds."""

    def __init__(
        self,
        *,
        key: str,
        client: httpx.AsyncClient,
        tracer: Tracer,
        model: str = JEV_MODEL,
        url: str = JEV_URL,
        attempts: int = 1,
        wait: float = 5.0,
        timeout: float | None = None,
    ) -> None:
        self._key = key
        self._client = client
        self._tracer = tracer
        self.model = model
        self.url = url
        self.attempts = max(attempts, 1)
        self.wait = wait
        self._timeout = timeout

    @property
    def engine(self) -> str:
        """The engine and its version, for usage, traces and benches: "jev-1.13"."""
        return self.model.rsplit("/", 1)[-1]

    async def decide_all(self, asks: Sequence[Ask]) -> list[Decision]:
        """The asks side by side, their decisions in the order of the asks.
        Independent judgements go in separate requests and so are answered
        apart. The first failure cancels the rest.

        A request counts as it leaves, not as its answer comes: a set that
        fails, or is cut, still says what it spent — the requests that went
        out, answered, failed or cancelled, and the cost of the answers that
        came. Not counted: a request still waiting its turn when the set was
        cancelled."""
        answered: list[Decision] = []
        sent = 0

        async def decide(ask: Ask) -> Decision:
            nonlocal sent
            sent += 1
            decision = await self.decide(ask)
            answered.append(decision)
            return decision

        try:
            return await all_of((decide(a) for a in asks), limit=IN_FLIGHT)
        except EngineError as err:
            err.usage = self._spent(sent, answered)  # what the set took before it failed
            raise
        except asyncio.CancelledError as cut:
            note_cut(cut, self._spent(sent, answered))  # or was cut: the requests out count all the same
            raise

    async def decide(self, ask: Ask) -> Decision:
        """One request, retried while its failure is transient and attempts
        are left."""
        attempt = 1
        while True:
            try:
                return await self._call(ask)
            except JevError as err:
                if not err.transient or attempt >= self.attempts:
                    raise
            await asyncio.sleep(self.wait * 2 ** (attempt - 1))
            attempt += 1

    def usage(self, decisions: Sequence[Decision]) -> Usage:
        """What a set of decisions took."""
        return self._spent(len(decisions), decisions)

    def _spent(self, sent: int, answered: Sequence[Decision]) -> Usage:
        """What a set took: the requests sent, and the cost of the answers that came."""
        return Usage(
            engine=self.engine,
            model=self.model,
            calls=sent,
            cost_usd=sum(d.cost_usd for d in answered),
        )

    async def _call(self, ask: Ask) -> Decision:
        """One HTTP call, and the answer held to the questions. Under Langfuse
        it is a generation with its input, its answers, its cost and its
        tokens."""
        if not self._key:
            raise JevError(f"{self.engine}: no API key")
        body = {
            "model": self.model,
            "state": dict(ask.state),
            "questions": {
                q.key: {"type": q.kind, "instructions": q.instructions, "criteria": q.criteria} for q in ask.questions
            },
        }
        # compact, the keys sorted: the JSON every quoter sends, and traces
        content = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        with self._tracer.generation(f"decide {self.engine}", model=self.model, input=content) as span:
            decision = self._decision(ask, await self._post(content.encode()))
            span.output({key: asdict(answer) for key, answer in decision.answers.items()})
            span.usage(
                input_tokens=decision.input_tokens,
                output_tokens=decision.output_tokens,
                cost_usd=decision.cost_usd,
            )
            return decision

    async def _post(self, content: bytes) -> tuple[int, bytes]:
        headers = {
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
            **HEADERS,
        }
        try:
            async with (
                asyncio.timeout(self._timeout),
                self._client.stream("POST", self.url, content=content, headers=headers) as response,
            ):
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw += chunk
                    if len(raw) > MAX_ANSWER_BYTES:
                        raise JevError(f"{self.engine}: status {response.status_code}: answer over 256 KiB")
                return response.status_code, bytes(raw)
        except TimeoutError as err:  # the whole call, past MODEL_TIMEOUT
            raise JevError(f"{self.engine}: no answer in {self._timeout}s", transient=True) from err
        except httpx.TimeoutException as err:
            raise JevError(f"{self.engine}: {type(err).__name__}", transient=True) from err
        except httpx.HTTPError as err:
            raise JevError(f"{self.engine}: {err}") from err

    def _decision(self, ask: Ask, answered: tuple[int, bytes]) -> Decision:
        status, raw = answered
        try:
            out = _Response.model_validate_json(raw)
        except ValidationError as err:
            raise JevError(
                f"{self.engine}: status {status}: bad JSON: {err.errors()[0]['msg']}",
                status=status,
                transient=status in TRANSIENT,
            ) from err
        if status != httpx.codes.OK or out.error is not None:
            message = out.error.message if out.error else ""
            raise JevError(
                f"{self.engine}: status {status}: {message}",
                status=status,
                transient=status in TRANSIENT,
            )
        decision = Decision(
            answers={
                k: Answer(
                    noul=a.noul,
                    choice=a.choice,
                    confidence=a.confidence,
                    probabilities=a.probabilities,
                )
                for k, a in out.answers.items()
            },
            id=out.id,
            engine=self.engine,
            model=self.model,
            cost_usd=out.usage.cost,
            input_tokens=out.usage.input_tokens or out.usage.prompt_tokens,
            output_tokens=out.usage.output_tokens or out.usage.completion_tokens,
        )
        _check(ask, decision)
        return decision


def _check(ask: Ask, decision: Decision) -> None:
    """Refuses an answer the questions could not have: a missing one, a choice
    outside its options, a probability outside [0, 1]. An engine that drifts
    is an error, not a verdict."""
    for q in ask.questions:
        a = decision.answers.get(q.key)
        if a is None:
            raise JevError(f"{decision.engine}: no answer for {q.key!r}")
        if q.kind == "choice" and a.choice not in q.criteria:
            raise JevError(f"{decision.engine}: {q.key!r} answered {a.choice!r}, not one of its options")
        if not all(0 <= p <= 1 for p in (a.noul, a.confidence, *a.probabilities.values())):
            raise JevError(f"{decision.engine}: {q.key!r} answered a probability outside [0, 1]")
