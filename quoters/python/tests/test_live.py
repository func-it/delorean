"""The live engines against recorded answers, on mock transports: what each
asks Jev or the LLM, and how it reads the answer. No model is called."""

import json
from collections.abc import Callable
from typing import Any

import httpx
import httpx2
import openai
import pytest

from delorean.cart import Film, Line, Mention
from delorean.config import OPENROUTER, Effort, LiveSettings
from delorean.engines.live import open_live_engines
from delorean.engines.live.jev import Jev
from delorean.engines.live.questions import CacheKey, JevGuard, JevIdentifier, JevJudge
from delorean.engines.live.reader import MAX_TOKENS, LlmReader
from delorean.lru import Lru
from delorean.pipeline import Check, EngineError, Finding, GuardAnswers, Identification, Retry, Usage
from delorean.prompts import Prompts, load_prompts
from delorean.telemetry import NoTracer
from tests.conftest import TINY_PROMPTS_DIR, Spans

type Decide = Callable[[dict[str, Any]], dict[str, Any]]


@pytest.fixture
def prompts() -> Prompts:
    """The tiny prompt set: these tests check how the engines assemble what
    they send, never the production wording."""
    return load_prompts(TINY_PROMPTS_DIR)


class Recorder:
    """A Jev that answers each request with decide(request body), and keeps
    the bodies."""

    def __init__(self, decide: Decide) -> None:
        self.bodies: list[dict[str, Any]] = []
        self._decide = decide

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        return httpx.Response(200, json={"id": "d", "answers": self._decide(body), "usage": {"cost": 0.0001}})

    def jev(self) -> Jev:
        return Jev(
            key="k",
            client=httpx.AsyncClient(transport=httpx.MockTransport(self)),
            tracer=NoTracer(),
        )


def noul(p: float) -> Decide:
    return lambda body: {key: {"noul": p, "confidence": 1} for key in body["questions"]}


async def test_guard_asks_two_questions_apart(prompts: Prompts) -> None:
    def decide(body: dict[str, Any]) -> dict[str, Any]:
        (key,) = body["questions"]
        return {key: {"noul": {"order": 0.9, "steer": 0.2}[key], "confidence": 1}}

    jev = Recorder(decide)
    answers, usage = await JevGuard(jev.jev(), prompts.guard).check("Heat x 2")
    assert answers == GuardAnswers(order=0.9, steer=0.2)
    assert (usage.engine, usage.model, usage.calls) == ("jev-1.13", "typesafe/jev-1.13", 2)
    assert usage.cost_usd == pytest.approx(0.0002)
    assert sorted(jev.bodies, key=lambda b: next(iter(b["questions"]))) == [
        {
            "model": "typesafe/jev-1.13",
            "state": {"customer_message": "Heat x 2"},
            "questions": {
                q.key: {"type": "noul", "instructions": q.instructions, "criteria": q.criteria},
            },
        }
        for q in (prompts.guard.order, prompts.guard.steer)
    ]


async def test_identifier_asks_one_title_per_request(prompts: Prompts) -> None:
    films = {"Retour vers le futur 2": "bttf_2", "Heat": "other"}

    def decide(body: dict[str, Any]) -> dict[str, Any]:
        film = films[body["state"]["film_title"]]
        return {"film": {"choice": film, "confidence": 0.9, "probabilities": {film: 0.9, "bttf_4": 0.1}}}

    jev = Recorder(decide)
    ids, usage = await JevIdentifier(jev.jev(), prompts.identify).identify(list(films))
    assert ids == [
        Identification(Film.BTTF_2, 0.9, {Film.BTTF_2: 0.9}),
        Identification(Film.OTHER, 0.9, {Film.OTHER: 0.9}),
    ]
    assert usage.calls == 2
    film = prompts.identify.film
    assert {b["state"]["film_title"] for b in jev.bodies} == set(films)
    assert all(
        b["questions"] == {"film": {"type": "choice", "instructions": film.instructions, "criteria": film.criteria}}
        for b in jev.bodies
    )


async def test_judge_puts_one_question_per_fact(prompts: Prompts) -> None:
    lines = [
        Line('Fast & "Furious"', 2, Film.OTHER, 1.0),
        Line("Retour vers le futur 2", 1, Film.BTTF_2, 0.9),
    ]
    text = '2 x Fast & "Furious"\nRetour vers le futur 2'
    jev = Recorder(noul(0.8))
    judge = JevJudge(jev.jev(), prompts.judge)

    probes = judge.probes(text, lines)
    assert [(p.check, p.label, dict(p.state)) for p in probes] == [
        (
            Check.ASKED,
            'Fast & "Furious"',
            {"customer_message": text, "order_line": '"Fast & \\"Furious\\""'},
        ),
        (
            Check.IDENTITY,
            'Fast & "Furious"',
            {
                "customer_message": text,
                "order_line": '"Fast & \\"Furious\\"", identified as ANOTHER FILM',
            },
        ),
        (
            Check.ASKED,
            "Retour vers le futur 2",
            {"customer_message": text, "order_line": '"Retour vers le futur 2"'},
        ),
        (
            Check.IDENTITY,
            "Retour vers le futur 2",
            {
                "customer_message": text,
                "order_line": '"Retour vers le futur 2", identified as FILM 2',
            },
        ),
        (
            Check.MISSING,
            "the whole reading",
            {
                "customer_message": text,
                "order_lines": '- 2 × "Fast & \\"Furious\\""\n- 1 × "Retour vers le futur 2"',
            },
        ),
    ]

    findings, usage = await judge.judge(text, lines)
    assert [(f.check, f.score) for f in findings] == [
        (Check.ASKED, 0.8),
        (Check.IDENTITY, 0.8),
        (Check.ASKED, 0.8),
        (Check.IDENTITY, 0.8),
        (Check.MISSING, pytest.approx(0.2)),  # "yes, a film is missing" is bad
    ]
    assert usage.calls == 5
    assert len(jev.bodies) == 5
    keys = sorted(next(iter(b["questions"])) for b in jev.bodies)
    assert keys == ["asked", "asked", "identity", "identity", "missing"]


async def test_judge_scores_the_missing_check_inverted(prompts: Prompts) -> None:
    findings, _ = await JevJudge(Recorder(noul(0.0)).jev(), prompts.judge).judge(
        "Heat", [Line("Heat", 1, Film.OTHER, 1)]
    )
    assert findings[-1] == Finding(Check.MISSING, "the whole reading", 1.0)


def completion(content: str | None, *, cost: float | None = 0.00012, **message: Any) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 412, "completion_tokens": 38, "total_tokens": 450}
    if cost is not None:
        usage["cost"] = cost
    return {
        "id": "gen-1",
        "object": "chat.completion",
        "created": 1_790_000_000,
        "model": "openai/gpt-6-luna",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": content, **message},
            }
        ],
        "usage": usage,
    }


class Llm:
    """An OpenAI-compatible endpoint that answers every call with `answer`,
    and keeps the requests."""

    def __init__(self, answer: dict[str, Any], status: int = 200) -> None:
        self.answer, self.status = answer, status
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return httpx2.Response(self.status, json=self.answer)

    def reader(
        self,
        prompts: Prompts,
        *,
        spans: Spans | None = None,
        effort: Effort = "low",
        names_films: bool = False,
    ) -> LlmReader:
        client = openai.AsyncOpenAI(
            api_key="k",
            base_url=OPENROUTER,
            max_retries=0,
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(self)),
        )
        tracer = spans.tracer if spans else NoTracer()
        return LlmReader(
            client=client,
            model="openai/gpt-6-luna",
            effort=effort,
            prompt=prompts.parse_films if names_films else prompts.parse,
            tracer=tracer,
            names_films=names_films,
        )


async def test_reader_asks_for_the_schema(prompts: Prompts) -> None:
    llm = Llm(
        completion(
            '{"films": [{"title": "Retour vers le futur 2", "quantity": 2}, {"title": " Heat ", "quantity": 1}]}'
        )
    )
    mentions, usage = await llm.reader(prompts).read("2 x Retour vers le futur 2\nHeat")
    assert mentions == [Mention("Retour vers le futur 2", 2), Mention("Heat", 1)]
    assert usage == Usage(engine="openai/gpt-6-luna", model="openai/gpt-6-luna", calls=1, cost_usd=0.00012)

    (request,) = llm.requests
    assert str(request.url) == f"{OPENROUTER}/chat/completions"
    body = json.loads(request.content)
    parse = prompts.parse
    assert body == {
        "model": "openai/gpt-6-luna",
        "messages": [
            {"role": "system", "content": parse.instruction},
            {
                "role": "user",
                "content": "<m>\n2 x Retour vers le futur 2\nHeat\n</m>",
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "reading", "schema": parse.json_schema, "strict": True},
        },
        "reasoning_effort": "low",
        "max_completion_tokens": MAX_TOKENS,
        "usage": {"include": True},
    }


async def test_reader_reads_again_told_what_failed(prompts: Prompts) -> None:
    llm = Llm(completion('{"films": [{"title": "Retour vers le futur 2", "quantity": 2}]}'))
    retry = Retry(
        reading=[Mention("Retour vers le futur 2", 1), Mention('Le "Grand" Bleu', 1)],
        failed=[
            Finding(Check.ASKED, 'Le "Grand" Bleu', 0.1),
            Finding(Check.COUNT, "bttf_2: 1 read, 2 recounted", 0.0),
        ],
    )
    await llm.reader(prompts).read("2 x Retour vers le futur 2", retry)
    messages = json.loads(llm.requests[0].content)["messages"]
    assert messages[:2] == [
        {"role": "system", "content": prompts.parse.instruction},
        {"role": "user", "content": "<m>\n2 x Retour vers le futur 2\n</m>"},
    ]
    assert messages[2] == {
        "role": "assistant",
        "content": '{"films":[{"title":"Retour vers le futur 2","quantity":1},'
        '{"title":"Le \\"Grand\\" Bleu","quantity":1}]}',
    }
    assert messages[3] == {
        "role": "user",
        "content": 'FAILED:\nasked|Le "Grand" Bleu|A\ncount|bttf_2: 1 read, 2 recounted|C\nAGAIN',
    }
    assert len(messages) == 4


async def test_reader_traces_its_call(prompts: Prompts, spans: Spans) -> None:
    await Llm(completion('{"films": []}')).reader(prompts, spans=spans).read("rien")
    attributes = spans.attributes("chat openai/gpt-6-luna")
    assert attributes["langfuse.observation.type"] == "generation"
    assert json.loads(attributes["langfuse.observation.usage_details"]) == {
        "input": 412,
        "output": 38,
    }
    assert json.loads(attributes["langfuse.observation.cost_details"]) == {"total": 0.00012}
    assert json.loads(attributes["langfuse.observation.input"])[1]["role"] == "user"
    assert json.loads(attributes["langfuse.observation.model.parameters"]) == {"reasoning_effort": "low"}


async def test_reader_without_a_cost_reported(prompts: Prompts) -> None:
    _, usage = await Llm(completion('{"films": []}', cost=None)).reader(prompts).read("rien")
    assert usage.cost_usd == 0


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param(completion("Heat, twice"), id="not JSON"),
        pytest.param(
            completion('{"films": [{"title": "Heat", "quantity": 2}]} and more'),
            id="text after the JSON",
        ),
        pytest.param(completion("{}"), id="no films"),
        pytest.param(completion('{"films": null}'), id="null films"),
        pytest.param(completion('{"films": [{"title": "Heat"}]}'), id="no quantity"),
        pytest.param(completion('{"films": [{"title": "Heat", "quantity": 0}]}'), id="a quantity of 0"),
        pytest.param(completion('{"films": [{"title": "Heat", "quantity": 1.5}]}'), id="a quantity not whole"),
        pytest.param(
            completion('{"films": [{"title": "Heat", "quantity": "2"}]}'),
            id="a quantity in a string",
        ),
        pytest.param(completion('{"films": [{"title": "  ", "quantity": 1}]}'), id="no title"),
        pytest.param(
            completion('{"films": [{"title": "Heat", "quantity": 1, "price": 0}]}'),
            id="a field more",
        ),
        pytest.param(completion('{"films": [], "total": 0}'), id="a field more at the top"),
        pytest.param(completion(None), id="no content"),
        pytest.param(completion(None, refusal="I cannot help with that"), id="a refusal"),
        pytest.param({**completion("{}"), "choices": []}, id="no choice"),
    ],
)
async def test_reader_holds_the_answer_to_its_schema(prompts: Prompts, answer: dict[str, Any]) -> None:
    with pytest.raises(EngineError) as raised:
        await Llm(answer).reader(prompts).read("Heat")
    billed = Usage(engine="openai/gpt-6-luna", model="openai/gpt-6-luna", calls=1, cost_usd=0.00012)
    assert raised.value.usage == billed, "an answer off its contract is billed all the same"


@pytest.mark.parametrize("status", [400, 401, 402, 429, 500, 503])
async def test_reader_failures_are_engine_errors(prompts: Prompts, status: int) -> None:
    llm = Llm({"error": {"message": "nope", "code": status}}, status=status)
    with pytest.raises(EngineError) as raised:
        await llm.reader(prompts).read("Heat")
    assert len(llm.requests) == 1, "no retry in the request path"
    assert raised.value.usage == Usage(engine="openai/gpt-6-luna", model="openai/gpt-6-luna", calls=1)


async def test_live_engines_are_wired_from_the_settings(prompts: Prompts) -> None:
    settings = LiveSettings(
        openrouter_api_key="k",
        parse_model="openai/gpt-6-luna",
        recount_model="deepseek/deepseek-v4.1-flash",
        recount_effort="medium",
        jev_model="typesafe/jev-1.13",
    )
    async with open_live_engines(settings, prompts, NoTracer()) as engines:
        assert engines.name == "live"
        assert isinstance(engines.parser, LlmReader)
        assert isinstance(engines.recounter, LlmReader)
        assert (engines.parser.model, engines.recounter.model) == (
            "openai/gpt-6-luna",
            "deepseek/deepseek-v4.1-flash",
        )
        assert isinstance(engines.guard, JevGuard)
        assert isinstance(engines.identifier, JevIdentifier)
        assert isinstance(engines.judge, JevJudge)


def films(answers: dict[str, str]) -> Recorder:
    return Recorder(lambda body: {"film": {"choice": answers[body["state"]["film_title"]], "confidence": 0.9}})


async def test_identifier_asks_jev_only_titles_it_has_not_identified(prompts: Prompts) -> None:
    jev = films({"Heat": "other", "BTTF 2": "bttf_2", "Ronin": "other"})
    identifier = JevIdentifier(jev.jev(), prompts.identify, version="fae24511", cache=Lru(100))
    _, first = await identifier.identify(["Heat", "BTTF 2"])
    ids, again = await identifier.identify(["bttf  2", "Ronin", "HEAT"])
    assert [i.film for i in ids] == [Film.BTTF_2, Film.OTHER, Film.OTHER]
    assert [b["state"]["film_title"] for b in jev.bodies] == ["Heat", "BTTF 2", "Ronin"], "case and spacing aside"
    assert (first.calls, first.cache_hits) == (2, 0)
    assert (again.calls, again.cache_hits) == (1, 2)


async def test_the_cache_key_holds_the_prompt_version_and_the_model(prompts: Prompts) -> None:
    jev = films({"Heat": "other"})
    cache: Lru[CacheKey, Identification] = Lru(100)
    await JevIdentifier(jev.jev(), prompts.identify, version="v1", cache=cache).identify(["Heat"])
    await JevIdentifier(jev.jev(), prompts.identify, version="v2", cache=cache).identify(["Heat"])
    client = httpx.AsyncClient(transport=httpx.MockTransport(jev))
    other_model = Jev(key="k", model="typesafe/jev-2.0", client=client, tracer=NoTracer())
    await JevIdentifier(other_model, prompts.identify, version="v1", cache=cache).identify(["Heat"])
    assert len(jev.bodies) == 3, "another prompt or another model asks again"


async def test_an_error_is_never_cached(prompts: Prompts) -> None:
    answers = iter([{"film": {"choice": "bttf_4", "confidence": 1}}, {"film": {"choice": "other", "confidence": 1}}])
    jev = Recorder(lambda body: next(answers))
    identifier = JevIdentifier(jev.jev(), prompts.identify, cache=Lru(100))
    with pytest.raises(EngineError):
        await identifier.identify(["Heat"])
    ids, usage = await identifier.identify(["Heat"])
    assert (ids[0].film, usage.calls, usage.cache_hits) == (Film.OTHER, 1, 0)


async def test_no_cache_asks_every_time(prompts: Prompts) -> None:
    jev = films({"Heat": "other"})
    identifier = JevIdentifier(jev.jev(), prompts.identify, cache=Lru(0))
    await identifier.identify(["Heat"])
    await identifier.identify(["Heat"])
    assert len(jev.bodies) == 2


async def test_reader_with_no_effort_sends_no_reasoning_field(prompts: Prompts) -> None:
    llm = Llm(completion('{"films": []}'))
    await llm.reader(prompts, effort="none").read("Heat")
    assert "reasoning_effort" not in json.loads(llm.requests[0].content)


async def test_reader_names_the_films_with_parse_films(prompts: Prompts) -> None:
    llm = Llm(completion('{"films": [{"title": "BTTF 2", "quantity": 2, "film": "bttf_2"}]}'))
    retry = Retry(
        reading=[Mention("BTTF 2", 1, Film.BTTF_2)], failed=[Finding(Check.COUNT, "bttf_2: 1 read, 2 recounted", 0.0)]
    )
    mentions, _ = await llm.reader(prompts, names_films=True).read("2 x BTTF 2", retry)
    assert mentions == [Mention("BTTF 2", 2, Film.BTTF_2)]
    body = json.loads(llm.requests[0].content)
    assert body["messages"][0]["content"] == prompts.parse_films.instruction
    assert body["response_format"]["json_schema"]["schema"] == prompts.parse_films.json_schema
    assert body["messages"][2]["content"] == '{"films":[{"title":"BTTF 2","quantity":1,"film":"bttf_2"}]}'


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param('{"films": [{"title": "Heat", "quantity": 1}]}', id="no film"),
        pytest.param('{"films": [{"title": "Heat", "quantity": 1, "film": "bttf_4"}]}', id="a film out of the enum"),
    ],
)
async def test_reader_holds_the_films_to_their_schema(prompts: Prompts, answer: str) -> None:
    with pytest.raises(EngineError):
        await Llm(completion(answer)).reader(prompts, names_films=True).read("Heat")


async def test_the_parse_reads_parse_films_when_it_identifies(prompts: Prompts) -> None:
    settings = LiveSettings(openrouter_api_key="k", parse_identifies=True, recount_base_url="http://localhost:11434/v1")
    async with open_live_engines(settings, prompts, NoTracer()) as engines:
        assert isinstance(engines.parser, LlmReader)
        assert isinstance(engines.recounter, LlmReader)
        assert engines.parser.names_films
        assert not engines.recounter.names_films, "the recount reads parse.json, always"
