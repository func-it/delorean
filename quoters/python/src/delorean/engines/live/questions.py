"""The guard, the identification and the judge: Jev's three stages. One
request per independent judgement, all side by side; the customer's text is
data, under a state key named for what it is."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Final

from delorean.cart import Film, Line, title_key
from delorean.engines.live.jev import Ask, Decision, Jev
from delorean.lru import Lru
from delorean.pipeline import WHOLE_READING, Check, Finding, GuardAnswers, Identification, Usage
from delorean.pipeline.rules import quoted
from delorean.prompts import GuardPrompts, IdentifyPrompts, JudgePrompts, Question

CUSTOMER_MESSAGE: Final = "customer_message"
"""The state key of the customer's text, wherever Jev reads it."""


class JevGuard:
    """Asks whether a request is a cart at all, before any LLM reads it: does
    it order films, and does some of it speak to the system — two facts, two
    requests."""

    def __init__(self, jev: Jev, prompts: GuardPrompts) -> None:
        self._jev = jev
        self._prompts = prompts

    async def check(self, text: str) -> tuple[GuardAnswers, Usage]:
        order, steer = self._prompts.order, self._prompts.steer
        decisions = await self._jev.decide_all(
            [Ask(state={CUSTOMER_MESSAGE: text}, questions=[q]) for q in (order, steer)]
        )
        answers = GuardAnswers(
            order=decisions[0].answers[order.key].noul,
            steer=decisions[1].answers[steer.key].noul,
        )
        return answers, self._jev.usage(decisions)


type CacheKey = tuple[str, str, str]
"""A title's merge key, the identify prompt's version, the Jev model: what an
identification depends on."""


class JevIdentifier:
    """Asks which film each title is, one request per title: a title read
    next to others would be coloured by them, and a long, noisy state
    distracts Jev.

    A title already identified is not asked again: its film depends on the
    title alone, and titles repeat. `cache` keeps the films of the last
    titles Jev answered, for the whole process; an error is never kept."""

    def __init__(
        self,
        jev: Jev,
        prompts: IdentifyPrompts,
        *,
        version: str = "",
        cache: Lru[CacheKey, Identification] | None = None,
    ) -> None:
        self._jev = jev
        self._film = prompts.film
        self._version = version
        self._cache: Lru[CacheKey, Identification] = cache if cache is not None else Lru(0)

    async def identify(self, titles: Sequence[str]) -> tuple[list[Identification], Usage]:
        known = {t: self._cache.get(self._key(t)) for t in titles}
        unknown = [t for t in titles if known[t] is None]
        decisions = await self._jev.decide_all([Ask(state={"film_title": t}, questions=[self._film]) for t in unknown])
        for title, decision in zip(unknown, decisions, strict=True):
            identification = self._identification(decision)
            known[title] = identification
            self._cache.put(self._key(title), identification)
        identifications = [known[t] for t in titles]
        hits = len(titles) - len(unknown) if self._cache.size > 0 else None
        usage = replace(self._jev.usage(decisions), cache_hits=hits)
        return [i for i in identifications if i is not None], usage

    def _key(self, title: str) -> CacheKey:
        return (title_key(title), self._version, self._jev.model)

    def _identification(self, decision: Decision) -> Identification:
        a = decision.answers[self._film.key]
        return Identification(
            film=Film(a.choice),
            confidence=a.confidence,
            probabilities={Film(k): p for k, p in a.probabilities.items() if k in Film},
        )


class JevJudge:
    """Holds a reading against the text it was read from, before any price,
    and keeps what the benches taught of Jev: a short question on one
    observable fact; one item per request; the worst score decides.

        asked     each line      does the customer ask to buy this film?          p
        identity  each line      is this title the film it was identified as?     p
        missing   whole reading  does the customer ask for a film not listed?     1 − p
    """

    def __init__(self, jev: Jev, prompts: JudgePrompts) -> None:
        self._jev = jev
        self._prompts = prompts

    async def judge(self, text: str, lines: Sequence[Line]) -> tuple[list[Finding], Usage]:
        probes = self.probes(text, lines)
        decisions = await self._jev.decide_all([p.ask for p in probes])
        findings = []
        for probe, decision in zip(probes, decisions, strict=True):
            p = decision.answers[probe.question.key].noul
            findings.append(Finding(check=probe.check, label=probe.label, score=1 - p if probe.inverted else p))
        return findings, self._jev.usage(decisions)

    def probes(self, text: str, lines: Sequence[Line]) -> list[Probe]:
        """Every question the judge puts about a reading, and what Jev reads
        for it (docs/architecture.md, "judge"): asked and identity for each
        line, then missing for the whole of it."""
        prompts = self._prompts
        out: list[Probe] = []
        for line in lines:
            title = quoted(line.title)
            identified = f"{title}, identified as {prompts.films[line.film]}"
            out += [
                Probe(
                    Check.ASKED,
                    line.title,
                    prompts.asked,
                    {CUSTOMER_MESSAGE: text, "order_line": title},
                ),
                Probe(
                    Check.IDENTITY,
                    line.title,
                    prompts.identity,
                    {CUSTOMER_MESSAGE: text, "order_line": identified},
                ),
            ]
        listed = "\n".join(f"- {line.quantity} × {quoted(line.title)}" for line in lines)
        out.append(
            Probe(
                Check.MISSING,
                WHOLE_READING,
                prompts.missing,
                {CUSTOMER_MESSAGE: text, "order_lines": listed},
                inverted=True,
            )
        )
        return out


@dataclass(frozen=True, slots=True)
class Probe:
    """One question of the judge, put about one item of the reading."""

    check: Check
    label: str
    question: Question
    state: Mapping[str, str]
    inverted: bool = False
    """Scores 1 − p: the question hunts a fault, and "yes" is bad."""

    @property
    def ask(self) -> Ask:
        return Ask(state=self.state, questions=[self.question])
