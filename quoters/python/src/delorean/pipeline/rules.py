"""The rules that decide, apart from the engines that answer: how the guard's
answers make a verdict, how a reading is taken, how the two readings are
compared. Plain functions of plain values."""

import json
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from delorean.cart import MAX_COPIES, MAX_QUANTITY, Film, Line, Mention, title_key
from delorean.pipeline.outcome import Copies, GuardVerdict, Judgement
from delorean.pipeline.ports import (
    WHOLE_READING,
    Check,
    EngineError,
    Finding,
    GuardAnswers,
    Identification,
    Verdict,
)


def unit(x: float) -> bool:
    """Whether x is a probability, 0 to 1. NaN is not."""
    return 0 <= x <= 1


def guard_verdict(answers: GuardAnswers) -> GuardVerdict:
    """The verdict the two answers make: injection = steer,
    valid = (1 − steer) × order, invalid = (1 − steer) × (1 − order). The
    likeliest wins, and its probability is the confidence; a tie goes to the
    refusal: injection, then invalid, then valid."""
    order, steer = answers.order, answers.steer
    if not (unit(order) and unit(steer)):
        raise EngineError(f"guard: order {order}, steer {steer}: not probabilities")
    probabilities = {
        Verdict.INJECTION: steer,
        Verdict.INVALID: (1 - steer) * (1 - order),
        Verdict.VALID: (1 - steer) * order,
    }
    verdict = max(probabilities, key=probabilities.__getitem__)  # the first of equals
    return GuardVerdict(
        verdict=verdict,
        confidence=probabilities[verdict],
        probabilities=probabilities,
        answers=answers,
    )


def merge(mentions: Iterable[Mention]) -> list[Mention]:
    """How the pipeline takes a reader's reading: the mentions of one title,
    whatever its case and spacing, add up under its first spelling, in the
    order of the text. A mention without title, or with a quantity under 1, is
    out of the reader's contract: dropping it would price a cart the customer
    did not write."""
    merged: dict[str, Mention] = {}
    for mention in mentions:
        title = mention.title.strip()
        if not title:
            raise EngineError("a mention has no title")
        if mention.quantity < 1:
            raise EngineError(f"{quoted(title)}: quantity {mention.quantity} is under 1")
        if mention.film is not None and mention.film not in Film:
            raise EngineError(f"{quoted(title)}: film {mention.film!r}")
        key = title_key(title)
        first = merged.get(key, Mention(title=title, quantity=0))
        total = min(first.quantity + mention.quantity, MAX_COPIES)
        merged[key] = Mention(title=first.title, quantity=total, film=first.film or mention.film)
    return list(merged.values())


def films_read(*readings: Sequence[Mention]) -> dict[str, Identification]:
    """The films the readings themselves give, by title key, the first one
    of a title: identified at confidence 1, and not put to the identifier."""
    read: dict[str, Identification] = {}
    for reading in readings:
        for mention in reading:
            if mention.film is not None:
                read.setdefault(title_key(mention.title), Identification(film=mention.film, confidence=1.0))
    return read


def too_many_copies(mentions: Iterable[Mention]) -> Copies | None:
    """The first title asked in more than MAX_QUANTITY copies, once merged."""
    return next(
        (Copies(m.title, m.quantity, MAX_QUANTITY) for m in mentions if m.quantity > MAX_QUANTITY),
        None,
    )


def distinct_titles(*readings: Sequence[Mention]) -> list[str]:
    """The titles of every reading, once each, case and spacing aside: the
    first reading's first, then those only a later one has."""
    titles: dict[str, str] = {}
    for reading in readings:
        for mention in reading:
            titles.setdefault(title_key(mention.title), mention.title)
    return list(titles.values())


def identified(titles: Sequence[str], identifications: Sequence[Identification]) -> dict[str, Identification]:
    """Each title's identification, by title key, as an identifier answers
    them: in the order of the titles. A missing one, or one with a film or a
    confidence out of the contract, is an engine error."""
    if len(identifications) != len(titles):
        raise EngineError(f"{len(identifications)} identifications for {len(titles)} titles")
    by_key: dict[str, Identification] = {}
    for title, identification in zip(titles, identifications, strict=True):
        if identification.film not in Film or not unit(identification.confidence):
            raise EngineError(
                f"{quoted(title)} identified as {identification.film!r} with confidence {identification.confidence}"
            )
        by_key[title_key(title)] = identification
    return by_key


def lines(reading: Sequence[Mention], identifications: Mapping[str, Identification]) -> list[Line]:
    """The reading's mentions with their identification."""
    out = []
    for mention in reading:
        identification = identifications[title_key(mention.title)]
        out.append(
            Line(
                title=mention.title,
                quantity=mention.quantity,
                film=Film(identification.film),
                confidence=identification.confidence,
            )
        )
    return out


def judged(findings: Sequence[Finding], reading: Sequence[Line]) -> list[Finding]:
    """The judge's findings, held to its contract: `asked` and `identity` for
    each line, in order, then `missing`, every score a probability."""
    expected = [*[Check.ASKED, Check.IDENTITY] * len(reading), Check.MISSING]
    if [f.check for f in findings] != expected:
        raise EngineError(f"judge: checks {[str(f.check) for f in findings]}, want {expected}")
    for finding in findings:
        if not unit(finding.score):
            raise EngineError(f"judge: {finding.check} {finding.label!r} scored {finding.score}")
    return list(findings)


def count_findings(reading: Sequence[Line], recount: Sequence[Line]) -> list[Finding]:
    """The `count` check: one finding per film either reading has, in the
    order of the films, 1 when both give it the same copies and 0 when they
    do not. Every film outside the saga counts together, as `other`: what the
    price depends on."""
    read, recounted = copies_by_film(reading), copies_by_film(recount)
    return [
        Finding(
            check=Check.COUNT,
            label=f"{film}: {read[film]} read, {recounted[film]} recounted",
            score=1.0 if read[film] == recounted[film] else 0.0,
        )
        for film in Film
        if film in read or film in recounted
    ]


def copies_by_film(reading: Iterable[Line]) -> Counter[Film]:
    copies: Counter[Film] = Counter()
    for line in reading:
        copies[line.film] = min(copies[line.film] + line.quantity, MAX_COPIES)
    return copies


def judgement(findings: Sequence[Finding]) -> Judgement:
    """The worst score decides; the judge's contract makes sure there is one."""
    return Judgement(score=min(f.score for f in findings), findings=findings)


def quoted(title: str) -> str:
    """A title in double quotes, JSON-escaped, as the problems and the judge
    show it."""
    return json.dumps(title, ensure_ascii=False)


NOTHING_READ = Judgement(score=0.0, findings=(Finding(check=Check.MISSING, label=WHOLE_READING, score=0.0),))
"""The judgement of a later reading with no film: it is not put to Jev, and
misses every film the customer asks for."""


type Fact = tuple[str, int, Film]
"""A line as the judge sees it: its title, its copies, its film."""


def facts(reading: Iterable[Line]) -> frozenset[Fact]:
    """What makes two readings the same to the judge: the same lines, in any
    order."""
    return frozenset(facts_in_order(reading))


@dataclass(frozen=True, slots=True)
class Judged:
    """The judge's findings on a reading, kept to be reused when a later
    attempt reads the same lines: a reading is put to Jev once. Only `count`,
    which depends on the recount, is computed anew."""

    by_line: Mapping[Fact, tuple[Finding, Finding]]
    missing: Finding

    @classmethod
    def of(cls, findings: Sequence[Finding], reading: Sequence[Line]) -> Judged:
        """findings, held to the judge's contract by `judged` first."""
        pairs = zip(findings[0:-1:2], findings[1:-1:2], strict=True)
        return cls(by_line=dict(zip(facts_in_order(reading), pairs, strict=True)), missing=findings[-1])

    def findings(self, reading: Sequence[Line]) -> list[Finding]:
        """The findings, in the order of reading's lines: asked and identity
        for each, then missing."""
        return [*(f for fact in facts_in_order(reading) for f in self.by_line[fact]), self.missing]


def facts_in_order(reading: Iterable[Line]) -> list[Fact]:
    return [(line.title, line.quantity, line.film) for line in reading]
