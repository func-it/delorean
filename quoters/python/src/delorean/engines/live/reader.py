"""The parse and the recount: an LLM reads the films a customer buys, and how
many copies of each, under a strict JSON schema. The schema is asked of the
model, and its answer held to it here: never trusted."""

import asyncio
import json
from collections.abc import Sequence
from typing import Final

import openai
from openai import omit
from openai.types.chat import ChatCompletion, ChatCompletionMessageParam
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from delorean.cart import Film, Mention
from delorean.config import Effort
from delorean.pipeline import EngineError, Retry, Usage
from delorean.pipeline.ports import note_cut
from delorean.prompts import ParsePrompt
from delorean.telemetry import Tracer

MAX_TOKENS: Final = 4096
"""Reasoning included; a reading is a few hundred."""


class _Film(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str
    quantity: int = Field(ge=1)


class _Reading(BaseModel):
    """An answer to prompts/parse.json's schema: JSON and nothing else, a list
    of films, each with a title and at least one copy."""

    model_config = ConfigDict(extra="forbid", strict=True)

    films: list[_Film]


class _NamedFilm(_Film):
    film: Film


class _NamedReading(BaseModel):
    """An answer to prompts/parse-films.json's schema: each film with its
    `film` too."""

    model_config = ConfigDict(extra="forbid", strict=True)

    films: list[_NamedFilm]


class LlmReader:
    """One reader: a model, its reasoning effort, its prompt. Bounded to one
    call and no tool: the cost of a reading does not rest on the model's good
    will. With `names_films`, the prompt is parse-films.json's and each line
    comes with its film. `timeout` bounds the whole call (MODEL_TIMEOUT), not
    the time of each phase of the connection."""

    def __init__(
        self,
        *,
        client: openai.AsyncOpenAI,
        model: str,
        effort: Effort,
        prompt: ParsePrompt,
        tracer: Tracer,
        names_films: bool = False,
        timeout: float | None = None,
    ) -> None:
        self._timeout = timeout
        self._client = client
        self.model = model
        self._effort = effort
        self._prompt = prompt
        self._tracer = tracer
        self.names_films = names_films

    async def read(self, text: str, retry: Retry | None = None) -> tuple[list[Mention], Usage]:
        # the customer's text in the user turn, fenced: data, never instructions
        messages: list[ChatCompletionMessageParam] = [
            {"role": "system", "content": self._prompt.instruction},
            {"role": "user", "content": self._prompt.user_turn(text)},
        ]
        if retry:
            # the conversation goes on: its last reading as its own answer,
            # then what the judge found wrong with it
            messages += [
                {"role": "assistant", "content": answered(retry.reading, names_films=self.names_films)},
                {"role": "user", "content": self._prompt.retry.render(retry.failed)},
            ]
        parameters = {"reasoning_effort": self._effort}
        with self._tracer.generation(
            f"chat {self.model}", model=self.model, input=messages, parameters=parameters
        ) as span:
            try:
                async with asyncio.timeout(self._timeout):
                    completion = await self._client.chat.completions.create(
                        model=self.model,
                        messages=messages,
                        response_format={
                            "type": "json_schema",
                            "json_schema": {
                                "name": "reading",
                                "schema": self._prompt.json_schema,
                                "strict": True,
                            },
                        },
                        # a model without reasoning refuses the field: none sends none
                        reasoning_effort=omit if self._effort == "none" else self._effort,
                        max_completion_tokens=MAX_TOKENS,
                        # OpenRouter reports the real cost of each call when asked to
                        extra_body={"usage": {"include": True}},
                    )
            except TimeoutError as err:  # the whole call, past MODEL_TIMEOUT
                raise EngineError(f"{self.model}: no answer in {self._timeout}s", usage=self._usage(0.0)) from err
            except asyncio.CancelledError as cut:  # cut from outside: the call went out, it counts
                note_cut(cut, self._usage(0.0))
                raise
            except openai.OpenAIError as err:
                raise EngineError(f"{self.model}: {err}", usage=self._usage(0.0)) from err
            cost, input_tokens, output_tokens = _metered(completion)
            span.usage(input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=cost)
            usage = self._usage(cost)
            try:
                answer = _answer(completion)
                span.output(answer)
                mentions = self._mentions(answer)
            except EngineError as err:
                err.usage = usage  # an answer off its contract is billed all the same
                raise
        return mentions, usage

    def _usage(self, cost: float) -> Usage:
        return Usage(engine=self.model, model=self.model, calls=1, cost_usd=cost)

    def _mentions(self, answer: str) -> list[Mention]:
        try:
            if self.names_films:
                named = _NamedReading.model_validate_json(answer).films
                mentions = [Mention(title=f.title.strip(), quantity=f.quantity, film=f.film) for f in named]
            else:
                read = _Reading.model_validate_json(answer).films
                mentions = [Mention(title=f.title.strip(), quantity=f.quantity) for f in read]
        except ValidationError as err:
            raise EngineError(f"{self.model}: answer off schema: {err.errors()[0]['msg']}") from err
        if untitled := [i + 1 for i, m in enumerate(mentions) if not m.title]:
            raise EngineError(f"{self.model}: answer off schema: film {untitled[0]} has no title")
        return mentions


def answered(reading: Sequence[Mention], *, names_films: bool = False) -> str:
    """A reading as the model answers it, in compact JSON as JSON.stringify
    writes it; with its films when the parse names them."""
    films: list[dict[str, object]] = []
    for m in reading:
        line: dict[str, object] = {"title": m.title, "quantity": m.quantity}
        if names_films and m.film is not None:
            line["film"] = m.film.value
        films.append(line)
    return json.dumps({"films": films}, ensure_ascii=False, separators=(",", ":"))


def _answer(completion: ChatCompletion) -> str:
    if not completion.choices:
        raise EngineError(f"{completion.model}: no answer")
    message = completion.choices[0].message
    if message.refusal:
        raise EngineError(f"{completion.model}: refused: {message.refusal}")
    if not message.content:
        raise EngineError(f"{completion.model}: an empty answer")
    return message.content


def _metered(completion: ChatCompletion) -> tuple[float, int, int]:
    """The cost OpenRouter billed, and the tokens."""
    usage = completion.usage
    if usage is None:
        return 0.0, 0, 0
    cost = (usage.model_extra or {}).get("cost", 0.0)
    return (
        (float(cost) if isinstance(cost, int | float) else 0.0),
        usage.prompt_tokens,
        usage.completion_tokens,
    )
