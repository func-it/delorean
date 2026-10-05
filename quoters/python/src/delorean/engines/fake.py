"""The engines of ENGINES=fake: deterministic stand-ins for Jev and the LLMs,
for end-to-end tests without OpenRouter, never in production. Their rules are
part of the test contract and the same in every implementation
(docs/architecture.md, "Fake engines")."""

import asyncio
import hashlib
import re
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Final, Literal

from delorean.cart import MAX_COPIES, Film, Line, Mention, title_key, trim_space
from delorean.pipeline import (
    WHOLE_READING,
    Check,
    EngineError,
    Engines,
    Finding,
    GuardAnswers,
    Identification,
    Retry,
    Usage,
)

# Lines of a cart that drive the fakes instead of naming films.
UNFAITHFUL: Final = "#fake:unfaithful"
"""A line of its own: the judge's missing check scores 0, on every attempt."""
REREAD: Final = "#fake:reread"
"""A line of its own: the first parse leaves out its last mention, the next
one reads it all."""
ENGINE_DOWN: Final = "#fake:engine_down"
"""A line of its own: the parse fails as an engine fails."""
MISCOUNT: Final = "#fake:miscount"
"""A line of its own: the recount reads one more copy of the first mention."""
RECOUNT_OFFSCHEMA: Final = "#fake:recount_offschema"
"""A line of its own: the recount answers off its schema, at every call; the
quote goes on without it."""
_DIRECTIVE: Final = "#fake:"

USAGE: Final = Usage(engine="fake", calls=1)
"""The same for every fake stage: one call, free."""

INJECTION_MARKS: Final = (
    "ignore",
    "disregard",
    "oublie",
    "instruction",
    "system prompt",
    "<script",
    "drop table",
)


type Latency = Literal["off", "real"]

BASE_MS: Final = {"guard": 400, "parse": 1200, "recount": 2500, "identify": 300, "judge": 350}
"""Each stage's time with FAKE_LATENCY=real, give or take 20 %."""


@dataclass(frozen=True, slots=True)
class Pace:
    """How long a fake call takes (docs/architecture.md, "Fake latency"):
    instant by default; with `real`, a model's time, the same in every quoter
    and every run; `cpu_ms` of busy processor first, which holds the event
    loop as CPU-bound work would."""

    latency: Latency = "off"
    cpu_ms: int = 0
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    """How a wait waits: asyncio's, which holds no thread."""

    async def __call__(self, stage: str, input: str) -> None:
        if self.cpu_ms:
            # busy on purpose, and synchronous: no await lets another request run
            end = time.perf_counter() + self.cpu_ms / 1000
            while time.perf_counter() < end:
                pass
        if self.latency == "real":
            # a cancelled wait ends the call: the request is over
            await self.sleep(wait_ms(stage, input) / 1000)


def wait_ms(stage: str, input: str) -> int:
    """base × 4/5 + ⌊base × 2n / (5 × 2³²)⌋, n the first 4 bytes of
    SHA-256(stage + "\n" + input), big-endian: integer arithmetic only."""
    base = BASE_MS[stage]
    n = int.from_bytes(hashlib.sha256(f"{stage}\n{input}".encode()).digest()[:4], "big")
    return base * 4 // 5 + base * 2 * n // (5 << 32)


INSTANT: Final = Pace()


def engines(pace: Pace = INSTANT) -> Engines:
    return Engines(
        name="fake",
        guard=FakeGuard(pace),
        parser=FakeReader(pace=pace),
        recounter=FakeReader(recount=True, pace=pace),
        identifier=FakeIdentifier(pace),
        judge=FakeJudge(pace),
    )


class FakeGuard:
    """steer is 0.99 for a text with one of the injection marks in any case,
    0.01 otherwise; order is 1 for a text with three letters in a row on a
    line, 0 otherwise."""

    def __init__(self, pace: Pace = INSTANT) -> None:
        self._pace = pace

    async def check(self, text: str) -> tuple[GuardAnswers, Usage]:
        await self._pace("guard", text)
        lowered = text.lower()
        steer = 0.99 if any(mark in lowered for mark in INJECTION_MARKS) else 0.01
        order = 1.0 if _three_letters(text) else 0.0
        return GuardAnswers(order=order, steer=steer), USAGE


def _three_letters(text: str) -> bool:
    """Whether text has three letters (Unicode L) in a row: \\p{L}{3}, which
    Python's re cannot say."""
    run = 0
    for c in text:
        run = run + 1 if c.isalpha() else 0
        if run == 3:
            return True
    return False


_QUANTITY_FIRST: Final = re.compile(r"([0-9]+) [x×] (.+)")
_QUANTITY_LAST: Final = re.compile(r"(.+) [x×] ([0-9]+)")


class FakeReader:
    """Reads each line that is not blank, and not a #fake: directive, as one
    mention: "N x title", "N × title", "title x N", "title × N", or a title
    alone for one copy.

    The parse leaves out its last mention when the text has a #fake:reread
    line and it reads for the first time, untold; told what failed, it reads
    everything. The recount reads everything, plus one copy of the first
    mention when the text has a #fake:miscount line; with a
    #fake:recount_offschema line it answers off its schema."""

    engine: Final = "fake"
    """What a call cut by its time is attributed to, as USAGE says."""

    def __init__(self, *, recount: bool = False, pace: Pace = INSTANT) -> None:
        self._recount = recount
        self._pace = pace

    async def read(self, text: str, retry: Retry | None = None) -> tuple[list[Mention], Usage]:
        await self._pace("recount" if self._recount else "parse", text)
        lines = text.split("\n")
        if self._recount and RECOUNT_OFFSCHEMA in lines:
            raise EngineError(f"fake recount: engine unavailable: answer off schema ({RECOUNT_OFFSCHEMA})", usage=USAGE)
        if ENGINE_DOWN in lines:
            raise EngineError(f"fake engine unavailable ({ENGINE_DOWN})", usage=USAGE)
        mentions = read_all(text)
        if self._recount and MISCOUNT in lines and mentions:
            first = mentions[0]
            mentions[0] = Mention(title=first.title, quantity=min(first.quantity + 1, MAX_COPIES))
        if not self._recount and REREAD in lines and retry is None:
            mentions = mentions[:-1]
        return mentions, USAGE


def read_all(text: str) -> list[Mention]:
    """Every mention of text, as the fake parse reads them all."""
    lines = (trim_space(raw) for raw in text.split("\n"))
    return [_mention(line) for line in lines if line and not line.startswith(_DIRECTIVE)]


def _mention(line: str) -> Mention:
    if (m := _QUANTITY_FIRST.fullmatch(line)) and (n := _quantity(m[1])):
        return Mention(title=trim_space(m[2]), quantity=n)
    if (m := _QUANTITY_LAST.fullmatch(line)) and (n := _quantity(m[2])):
        return Mention(title=trim_space(m[1]), quantity=n)
    return Mention(title=line, quantity=1)


def _quantity(digits: str) -> int:
    """N, or 0 when it is no quantity and part of the title. An N past 64
    bits reads as the largest one, as in Go: still a quantity, which the
    pipeline refuses as too large."""
    significant = digits.lstrip("0")
    if len(significant) > len(str(MAX_COPIES)):
        return MAX_COPIES
    return min(int(significant or "0"), MAX_COPIES)


_SAGA_TITLE: Final = re.compile(r"back to the future (?:part )?(1|2|3|i|ii|iii)")
_VOLUMES: Final = {
    "1": Film.BTTF_1,
    "i": Film.BTTF_1,
    "2": Film.BTTF_2,
    "ii": Film.BTTF_2,
    "3": Film.BTTF_3,
    "iii": Film.BTTF_3,
}


class FakeIdentifier:
    """Knows the saga under its English title only: "back to the future" then
    1, 2, 3, i, ii or iii, with or without "part", in any case and spacing.
    Every other title is another film."""

    def __init__(self, pace: Pace = INSTANT) -> None:
        self._pace = pace

    async def identify(self, titles: Sequence[str]) -> tuple[list[Identification], Usage]:
        await self._pace("identify", "\n".join(titles))
        return [Identification(film=identify(t), confidence=1.0) for t in titles], USAGE


def identify(title: str) -> Film:
    m = _SAGA_TITLE.fullmatch(title_key(title))
    return _VOLUMES[m[1]] if m else Film.OTHER


class FakeJudge:
    """Holds every check at 1 but missing, which scores 0 when the text has a
    #fake:unfaithful line, or when the reading lacks a title the fake parse
    reads in full."""

    def __init__(self, pace: Pace = INSTANT) -> None:
        self._pace = pace

    async def judge(self, text: str, lines: Sequence[Line]) -> tuple[list[Finding], Usage]:
        await self._pace("judge", text)
        read = {title_key(line.title) for line in lines}
        lacking = any(title_key(m.title) not in read for m in read_all(text))
        missing = 0.0 if UNFAITHFUL in text.split("\n") or lacking else 1.0
        findings = [
            finding
            for line in lines
            for finding in (
                Finding(check=Check.ASKED, label=line.title, score=1.0),
                Finding(check=Check.IDENTITY, label=line.title, score=1.0),
            )
        ]
        findings.append(Finding(check=Check.MISSING, label=WHOLE_READING, score=missing))
        return findings, USAGE
