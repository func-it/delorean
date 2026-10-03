"""Every word put to a model, read from prompts/ (docs/architecture.md,
"Shared prompts"): the three implementations ask the same questions, so they
are compared on their code and not on their prompts.

The files are checked when the service starts: a question with the wrong
options, or a film without a name, stops it there rather than at the first
quote. A stage's version is the first 8 hex digits of the SHA-256 of its
file's bytes."""

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from delorean.cart import Film
from delorean.pipeline import Check, Finding


class PromptError(ValueError):
    """A prompt file is missing or does not hold what its stage asks."""


class Question(BaseModel):
    """One question as Jev takes it: `criteria` has `true` and `false` for a
    noul, one entry per option for a choice."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    key: str
    kind: Literal["noul", "choice"]
    instructions: str
    criteria: dict[str, str]

    @model_validator(mode="after")
    def _criteria_fit_the_kind(self) -> Self:
        if self.kind == "noul" and set(self.criteria) != {"true", "false"}:
            raise ValueError(f"{self.key}: a noul's criteria are true and false")
        if self.kind == "choice" and len(self.criteria) < 2:
            raise ValueError(f"{self.key}: a choice has two options or more")
        return self


class _File(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)


class GuardPrompts(_File):
    order: Question
    steer: Question


class Fence(_File):
    before: str
    after: str


class RetryPrompt(_File):
    """The turn that asks for a new reading: `turn`, its {findings} one
    `finding` line per failing check, {check}, {label} and {meaning}."""

    turn: str
    finding: str
    meanings: dict[Check, str]
    """What each check's failure means, in the model's terms."""

    def render(self, failed: Sequence[Finding]) -> str:
        lines = [_fill(self.finding, check=f.check, label=f.label, meaning=self.meanings[f.check]) for f in failed]
        return _fill(self.turn, findings="\n".join(lines))


class ParsePrompt(_File):
    """The instruction, the JSON schema of a reading, the fence around the
    customer's message, and the turn that asks for a new reading. Parse and
    recount share it."""

    instruction: str
    json_schema: dict[str, Any] = Field(alias="schema")
    message: Fence
    retry: RetryPrompt

    def user_turn(self, text: str) -> str:
        return self.message.before + text + self.message.after


def _fill(template: str, **values: str) -> str:
    """template with each {name} of values replaced, in one pass: a value that
    holds braces, a title for one, is left as it is."""
    return re.sub(r"\{(\w+)\}", lambda m: values.get(m[1], m[0]), template)


class IdentifyPrompts(_File):
    film: Question


class JudgePrompts(_File):
    asked: Question
    identity: Question
    missing: Question
    films: dict[Film, str]
    """Each film's name, as the identity question shows it."""


@dataclass(frozen=True, slots=True)
class Prompts:
    guard: GuardPrompts
    parse: ParsePrompt
    parse_films: ParsePrompt
    """The parse's when it identifies the films too (PARSE_IDENTIFIES)."""
    identify: IdentifyPrompts
    judge: JudgePrompts
    versions: Mapping[str, str]
    """The version of each prompt file, by stage — guard, parse, recount,
    identify, judge — and parse-films."""


def load_prompts(directory: Path) -> Prompts:
    """Reads and checks the prompt files of directory, and those only: it may
    hold other files (a Go module)."""
    guard, guard_version = _read(directory / "guard.json", GuardPrompts)
    parse, parse_version = _read(directory / "parse.json", ParsePrompt)
    parse_films, parse_films_version = _read(directory / "parse-films.json", ParsePrompt)
    identify, identify_version = _read(directory / "identify.json", IdentifyPrompts)
    judge, judge_version = _read(directory / "judge.json", JudgePrompts)

    if set(identify.film.criteria) != set(Film):
        raise PromptError(f"{directory / 'identify.json'}: film's options must be {list(Film)}")
    for name, reading in (("parse.json", parse), ("parse-films.json", parse_films)):
        if set(reading.retry.meanings) != set(Check):
            raise PromptError(f"{directory / name}: retry.meanings must explain {list(Check)}")
    if not _names_films(parse_films.json_schema):
        raise PromptError(f"{directory / 'parse-films.json'}: each film's schema must have a film among {list(Film)}")
    if set(judge.films) != set(Film):
        raise PromptError(f"{directory / 'judge.json'}: films must name {list(Film)}")
    if identify.film.kind != "choice" or any(
        q.kind != "noul" for q in (guard.order, guard.steer, judge.asked, judge.identity, judge.missing)
    ):
        raise PromptError(f"{directory}: film is a choice, every other question a noul")

    return Prompts(
        guard=guard,
        parse=parse,
        parse_films=parse_films,
        identify=identify,
        judge=judge,
        versions={
            "guard": guard_version,
            "parse": parse_version,
            "recount": parse_version,
            "identify": identify_version,
            "judge": judge_version,
            "parse-films": parse_films_version,
        },
    )


def _names_films(schema: Mapping[str, Any]) -> bool:
    """Whether a reading's schema asks each film for its `film`, one of Film."""
    try:
        film = schema["properties"]["films"]["items"]["properties"]["film"]
    except KeyError, TypeError:
        return False
    return isinstance(film, dict) and set(film.get("enum", ())) == set(Film)


def version(content: bytes) -> str:
    """The version of a prompt file: the first 8 hex digits of its SHA-256."""
    return hashlib.sha256(content).hexdigest()[:8]


def _read[F: _File](path: Path, model: type[F]) -> tuple[F, str]:
    try:
        content = path.read_bytes()
    except OSError as err:
        raise PromptError(f"{path}: {err.strerror}") from err
    try:
        return model.model_validate_json(content), version(content)
    except ValidationError as err:
        raise PromptError(f"{path}: {err}") from err
