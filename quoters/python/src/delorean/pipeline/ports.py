"""What the pipeline asks of its engines, and what they answer.

Each model stage is a port, a Protocol, answered by a live engine (Jev or an
LLM, through OpenRouter) or by a deterministic fake in tests. An engine that
fails, or that answers outside its contract, raises EngineError."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal, Protocol

from delorean.cart import Film, Line, Mention


class Stage(StrEnum):
    """A step of the reading, as the API contract names it, in pipeline
    order."""

    PREPARE = "prepare"
    GUARD = "guard"
    PARSE = "parse"
    RECOUNT = "recount"
    IDENTIFY = "identify"
    JUDGE = "judge"
    PRICE = "price"


class EngineError(Exception):
    """A model engine failed: unreachable, out of credit, too slow, or an
    answer outside its contract. The API answers 502 engine_unavailable.

    `usage` is what the engine took before it failed — its calls and the
    cost billed so far — which a refusal beside the failure still reports."""

    def __init__(self, message: str, *, usage: Usage | None = None) -> None:
        super().__init__(message)
        self.usage = usage
        self.stage: Stage | None = None
        """The stage that failed, which the message starts with once set."""

    def __str__(self) -> str:
        message = super().__str__()
        return f"{self.stage}: {message}" if self.stage else message


@dataclass(frozen=True, slots=True)
class Usage:
    """What an engine took for one stage."""

    engine: str
    """Who answered: "jev-1.13", "openai/gpt-6-luna", "fake", "local"."""
    model: str | None = None
    calls: int = 0
    cost_usd: float = 0.0
    """As OpenRouter bills it."""
    cache_hits: int | None = None
    """Answers taken from a cache, which made no call; None with no cache."""


LOCAL = Usage(engine="local")
"""The usage of a stage that is plain code."""


class Verdict(StrEnum):
    VALID = "valid"
    """A cart: films to buy, in any language, inside a story or not."""
    INJECTION = "injection"
    """Tries to instruct, manipulate or hack the system."""
    INVALID = "invalid"
    """No cart: gibberish, a language not understood, off topic."""


@dataclass(frozen=True, slots=True)
class GuardAnswers:
    """The guard's two questions, each answered on its own."""

    order: float
    """The probability that the message orders films."""
    steer: float
    """The probability that some of it speaks to the system rather than to
    the shop."""


@dataclass(frozen=True, slots=True)
class Identification:
    """What one title was identified as."""

    film: Film
    confidence: float
    probabilities: Mapping[Film, float] = field(default_factory=dict)


class Check(StrEnum):
    """A kind of question the judge puts."""

    ASKED = "asked"
    """The customer asks for this film: nothing was invented."""
    IDENTITY = "identity"
    """The title is the film it was identified as."""
    COUNT = "count"
    """The reading and the recount give this film the same copies."""
    MISSING = "missing"
    """No film the customer asks for is left out of the reading."""


WHOLE_READING = "the whole reading"
"""The label of the missing check, which is put about the whole reading."""


@dataclass(frozen=True, slots=True)
class Finding:
    """The answer to one question of the judge, as a score where 1 means
    faithful."""

    check: Check
    label: str
    score: float


class Guard(Protocol):
    """Decides whether a request is a cart to read at all."""

    async def check(self, text: str) -> tuple[GuardAnswers, Usage]: ...


@dataclass(frozen=True, slots=True)
class Retry:
    """What a parse is told when it reads a cart again: the reading it gave
    last, and the checks of the judgement that failed it, in their order."""

    reading: Sequence[Mention]
    failed: Sequence[Finding]


class Reader(Protocol):
    """Lists the films the customer asks to buy, with their quantities; films
    mentioned but not bought are left out. The parse is one reader, the
    recount another. A parse reads again told what failed (`retry`); a
    recount is never told: it stays a second opinion."""

    async def read(self, text: str, retry: Retry | None = None) -> tuple[list[Mention], Usage]: ...


class Identifier(Protocol):
    """Identifies titles, one independent judgement per title, answered in the
    order of the titles."""

    async def identify(self, titles: Sequence[str]) -> tuple[list[Identification], Usage]: ...


class Judge(Protocol):
    """Holds a reading against the text it was read from: `asked` and
    `identity` for each line, in order, then `missing`. One short question per
    observable fact, asked on its own. The `count` check is the pipeline's."""

    async def judge(self, text: str, lines: Sequence[Line]) -> tuple[list[Finding], Usage]: ...


@dataclass(frozen=True, slots=True)
class Engines:
    """The ports one pipeline runs on."""

    name: Literal["live", "fake"]
    guard: Guard
    parser: Reader
    recounter: Reader
    identifier: Identifier
    judge: Judge
    caches_identifications: bool = False
    """Whether the identifier keeps the films of the titles it identified."""
