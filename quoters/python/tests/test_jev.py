"""The Jev client's wire handling, against recorded answers on a mock
transport: the protocol, the checks, the errors, the retries, the trace."""

import asyncio
import json
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest

from delorean.engines.live.jev import JEV_MODEL, JEV_URL, Ask, Jev, JevError
from delorean.pipeline import EngineError
from delorean.pipeline.ports import cut_usage
from delorean.prompts import Question
from delorean.telemetry import NoTracer
from tests.conftest import Spans

FILM = Question(
    key="film",
    kind="choice",
    instructions="Which film?",
    criteria={"bttf_1": "the first", "other": "another"},
)
YES = Question(key="yes", kind="noul", instructions="Is it?", criteria={"true": "it is", "false": "it is not"})

type Handler = Callable[[httpx.Request], httpx.Response]


def answering(status: int, body: str | dict[str, Any], seen: list[httpx.Request] | None = None) -> Handler:
    def handle(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        content = body if isinstance(body, str) else json.dumps(body)
        return httpx.Response(status, content=content)

    return handle


def jev(
    handler: Handler,
    *,
    key: str = "k",
    model: str = JEV_MODEL,
    spans: Spans | None = None,
    **kw: Any,
) -> Jev:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    tracer = spans.tracer if spans else NoTracer()
    return Jev(key=key, model=model, client=client, tracer=tracer, **kw)


ANSWER = {
    "id": "d1",
    "answers": {
        "film": {
            "choice": "bttf_1",
            "confidence": 0.8,
            "probabilities": {"bttf_1": 0.8, "other": 0.2},
        },
        "yes": {"noul": 0.7, "confidence": 0.7},
    },
    "usage": {"cost": 0.00004, "input_tokens": 312, "output_tokens": 5},
}


async def test_speaks_the_decisions_protocol() -> None:
    seen: list[httpx.Request] = []
    d = await jev(answering(200, ANSWER, seen)).decide(
        Ask(state={"film_title": "Retour vers le futur"}, questions=[FILM, YES])
    )
    assert (d.answers["film"].choice, d.answers["yes"].noul, d.id, d.cost_usd) == (
        "bttf_1",
        0.7,
        "d1",
        0.00004,
    )
    assert d.answers["film"].probabilities == {"bttf_1": 0.8, "other": 0.2}
    assert (d.engine, d.model, d.input_tokens, d.output_tokens) == ("jev-1.13", JEV_MODEL, 312, 5)

    (request,) = seen
    assert (request.method, str(request.url)) == ("POST", JEV_URL)
    assert request.headers["authorization"] == "Bearer k"
    assert request.headers["x-title"] == "delorean"
    assert request.headers["http-referer"] == "https://github.com/func-it/delorean"
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {
        "model": JEV_MODEL,
        "state": {"film_title": "Retour vers le futur"},
        "questions": {
            "film": {"type": "choice", "instructions": "Which film?", "criteria": FILM.criteria},
            "yes": {"type": "noul", "instructions": "Is it?", "criteria": YES.criteria},
        },
    }


async def test_sends_the_keys_sorted_and_the_text_as_written() -> None:
    seen: list[httpx.Request] = []
    await jev(answering(200, ANSWER, seen)).decide(Ask(state={"z": "é <&>", "a": "1"}, questions=[YES, FILM]))
    body = seen[0].content.decode()
    assert body.index('"model"') < body.index('"questions"') < body.index('"state"')
    assert body.index('"film"') < body.index('"yes"')
    assert body.index('"false"') < body.index('"true"')
    assert '"é <&>"' in body


def test_the_model_names_the_engine() -> None:
    j = jev(answering(200, ANSWER), model="typesafe/jev-2.0")
    assert (j.model, j.engine) == ("typesafe/jev-2.0", "jev-2.0")


@pytest.mark.parametrize(
    ("usage", "tokens"),
    [
        ({"cost": 0.00003, "input_tokens": 312, "output_tokens": 5}, (312, 5)),
        ({"cost": 0.00003, "prompt_tokens": 298, "completion_tokens": 4}, (298, 4)),
        ({"cost": 0.00003}, (0, 0)),
    ],
)
async def test_records_its_tokens_and_cost(spans: Spans, usage: dict[str, float], tokens: tuple[int, int]) -> None:
    body = {"id": "d1", "answers": {"film": {"choice": "other", "confidence": 0.9}}, "usage": usage}
    d = await jev(answering(200, body), spans=spans).decide(Ask(state={}, questions=[FILM]))
    assert (d.input_tokens, d.output_tokens, d.cost_usd) == (*tokens, 0.00003)

    attributes = spans.attributes("decide jev-1.13")
    assert attributes["langfuse.observation.type"] == "generation"
    assert attributes["langfuse.observation.model.name"] == JEV_MODEL
    assert json.loads(attributes["langfuse.observation.cost_details"]) == {"total": 0.00003}
    details = attributes.get("langfuse.observation.usage_details")
    # no count, no details: a 0 would read as a free call
    assert (json.loads(details) if details else None) == (
        {"input": tokens[0], "output": tokens[1]} if any(tokens) else None
    )
    assert json.loads(attributes["langfuse.observation.output"])["film"]["choice"] == "other"
    assert json.loads(attributes["langfuse.observation.input"])["model"] == JEV_MODEL


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"answers": {"film": {"choice": "bttf_4"}}}, id="an option the question does not have"),
        pytest.param({"answers": {}}, id="a question left unanswered"),
        pytest.param({"answers": {"film": {"choice": "other", "confidence": 1.3}}}, id="a confidence over 1"),
        pytest.param(
            {"answers": {"film": {"choice": "other", "confidence": 1, "probabilities": {"other": -0.1}}}},
            id="a probability under 0",
        ),
        pytest.param({"answers": {"film": {"choice": 3}}}, id="a choice that is not a string"),
        pytest.param({"answers": {"film": {"choice": "other", "confidence": "high"}}}, id="not a number"),
    ],
)
async def test_answers_outside_the_question_are_refused(body: dict[str, Any]) -> None:
    with pytest.raises(JevError):
        await jev(answering(200, body)).decide(Ask(state={}, questions=[FILM]))


async def test_a_noul_answer_without_its_probability_is_an_engine_error_not_zero() -> None:
    answer = {"answers": {"yes": {"confidence": 1}}}
    with pytest.raises(JevError, match=r"jev-1.13: 'yes' has no noul probability"):
        await jev(answering(200, answer)).decide(Ask(state={}, questions=[YES]))


async def test_a_noul_of_zero_is_an_answer() -> None:
    decision = await jev(answering(200, {"answers": {"yes": {"noul": 0, "confidence": 1}}})).decide(
        Ask(state={}, questions=[YES])
    )
    assert decision.answers["yes"].noul == 0


async def test_a_choice_has_no_noul_to_give() -> None:
    answer = {"answers": {"film": {"choice": "other", "confidence": 1, "probabilities": {"other": 1}}}}
    decision = await jev(answering(200, answer)).decide(Ask(state={}, questions=[FILM]))
    assert decision.answers["film"].choice == "other"


@pytest.mark.parametrize(
    ("status", "body", "message", "transient"),
    [
        (429, {"error": {"message": "slow down"}}, "status 429: slow down", True),
        (529, {"error": {"message": "overloaded"}}, "status 529: overloaded", True),
        (
            402,
            {"error": {"message": "insufficient credits"}},
            "status 402: insufficient credits",
            False,
        ),
        (502, "<html>bad gateway</html>", "status 502: bad JSON", True),
        (200, {"error": {"message": "upstream"}}, "status 200: upstream", False),
    ],
)
async def test_errors_carry_status_and_message(
    status: int, body: str | dict[str, Any], message: str, transient: bool
) -> None:
    with pytest.raises(JevError, match=message) as raised:
        await jev(answering(status, body)).decide(Ask(state={}, questions=[FILM]))
    assert (raised.value.status, raised.value.transient) == (status, transient)
    assert isinstance(raised.value, EngineError)


async def test_no_key_is_an_error_before_any_call() -> None:
    seen: list[httpx.Request] = []
    with pytest.raises(EngineError, match="no API key"):
        await jev(answering(200, ANSWER, seen), key="").decide(Ask(state={}, questions=[FILM]))
    assert seen == []


async def test_an_answer_too_large_is_refused() -> None:
    with pytest.raises(JevError, match="256 KiB"):
        await jev(answering(200, "x" * (300 << 10))).decide(Ask(state={}, questions=[FILM]))


async def test_a_network_failure_is_an_engine_error() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(JevError) as raised:
        await jev(refuse).decide(Ask(state={}, questions=[FILM]))
    assert not raised.value.transient
    with pytest.raises(JevError) as raised:
        await jev(slow).decide(Ask(state={}, questions=[FILM]))
    assert raised.value.transient


async def test_no_retry_by_default() -> None:
    seen: list[httpx.Request] = []
    with pytest.raises(JevError):
        await jev(answering(429, {"error": {"message": "slow down"}}, seen)).decide(Ask(state={}, questions=[FILM]))
    assert len(seen) == 1, "in the request path a customer is waiting"


async def test_retries_wait_out_transient_failures() -> None:
    recorded: list[tuple[int, str | dict[str, Any]]] = [
        (429, {"error": {"message": "slow down"}}),
        (503, "x"),
        (200, ANSWER),
    ]
    answers = iter(recorded)
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        status, body = next(answers)
        return answering(status, body, seen)(request)

    d = await jev(handle, attempts=3, wait=0).decide(Ask(state={}, questions=[FILM, YES]))
    assert (d.id, len(seen)) == ("d1", 3)


async def test_retries_wait_5_then_10_seconds_without_waiting_for_real() -> None:
    waited: list[float] = []

    async def record(seconds: float) -> None:
        waited.append(seconds)

    seen: list[httpx.Request] = []
    recorded: Iterator[tuple[int, dict[str, Any]]] = iter(
        [(429, {"error": {"message": "rate"}}), (529, {"error": {"message": "busy"}}), (200, ANSWER)]
    )

    def handle(request: httpx.Request) -> httpx.Response:
        status, body = next(recorded)
        return answering(status, body, seen)(request)

    d = await jev(handle, attempts=3, sleep=record).decide(Ask(state={}, questions=[FILM, YES]))
    assert (d.id, len(seen)) == ("d1", 3)
    assert waited == [5.0, 10.0], "5 s, then 10 s: what the real pauses would be"


async def test_retries_stop_at_a_lasting_failure() -> None:
    seen: list[httpx.Request] = []
    with pytest.raises(JevError, match="402"):
        await jev(answering(402, {"error": {"message": "credits"}}, seen), attempts=3, wait=0).decide(
            Ask(state={}, questions=[FILM])
        )
    assert len(seen) == 1


async def test_decide_all_keeps_the_order_and_bounds_the_flight() -> None:
    in_flight = peak = 0

    async def handle(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.001)
        in_flight -= 1
        title = json.loads(request.content)["state"]["film_title"]
        answer = {"film": {"choice": "other", "confidence": 1, "probabilities": {"other": 1}}}
        return httpx.Response(200, json={"id": title, "answers": answer, "usage": {"cost": 0.001}})

    j = Jev(key="k", client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), tracer=NoTracer())
    asks = [Ask(state={"film_title": str(i)}, questions=[FILM]) for i in range(40)]
    decisions = await j.decide_all(asks)
    assert [d.id for d in decisions] == [str(i) for i in range(40)]
    assert peak == 16
    usage = j.usage(decisions)
    assert (usage.engine, usage.model, usage.calls) == ("jev-1.13", JEV_MODEL, 40)
    assert usage.cost_usd == pytest.approx(0.04)


async def test_decide_all_fails_with_its_first_failure() -> None:
    async def handle(request: httpx.Request) -> httpx.Response:
        n = int(json.loads(request.content)["state"]["n"])
        if n == 3:
            await asyncio.sleep(0.01)  # the first two have answered, the others are still out
            return httpx.Response(402, json={"error": {"message": "credits"}})
        await asyncio.sleep(0 if n < 2 else 10)
        return httpx.Response(200, json=ANSWER)

    j = Jev(key="k", client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), tracer=NoTracer())
    asks = [Ask(state={"n": str(i)}, questions=[FILM]) for i in range(8)]
    with pytest.raises(JevError, match="credits") as raised:
        await j.decide_all(asks)
    usage = raised.value.usage
    assert usage is not None, "what the set took before it failed"
    assert (usage.engine, usage.calls) == ("jev-1.13", 8), "the requests that went out, cancelled or not"
    assert usage.cost_usd == pytest.approx(2 * 0.00004), "the cost of the answers that came in time"


async def test_decide_all_does_not_count_a_request_that_never_left() -> None:
    """Past 16 requests in flight the others wait their turn: cancelled there, they were never sent."""
    started = 0
    all_out = asyncio.Event()

    async def handle(request: httpx.Request) -> httpx.Response:
        nonlocal started
        started += 1
        if started == 16:
            all_out.set()
        await all_out.wait()
        if int(json.loads(request.content)["state"]["n"]) == 3:
            return httpx.Response(402, json={"error": {"message": "credits"}})
        await asyncio.sleep(30)
        raise AssertionError("not cancelled")

    j = Jev(key="k", client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), tracer=NoTracer())
    asks = [Ask(state={"n": str(i)}, questions=[FILM]) for i in range(20)]
    with pytest.raises(JevError, match="credits") as raised:
        await j.decide_all(asks)
    assert raised.value.usage is not None
    # a request that was waiting its turn when the first failure came is not sent: not all 20 count (the
    # slot the failed one freed may let one more start before the set is cancelled)
    assert 16 <= raised.value.usage.calls <= 17, "the requests past the 16 in flight that waited were never sent"


async def test_decide_all_cut_from_outside_says_what_went_out() -> None:
    """A set cancelled — the request's time out, the client gone — still counts the requests it had sent."""
    sent = 0
    all_out = asyncio.Event()

    async def handle(request: httpx.Request) -> httpx.Response:
        nonlocal sent
        sent += 1
        if sent == 5:
            all_out.set()
        await asyncio.sleep(30)
        raise AssertionError("not cancelled")

    j = Jev(key="k", client=httpx.AsyncClient(transport=httpx.MockTransport(handle)), tracer=NoTracer())
    task = asyncio.create_task(j.decide_all([Ask(state={"n": str(i)}, questions=[FILM]) for i in range(5)]))
    await all_out.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError) as raised:
        await task
    usage = cut_usage(raised.value)
    assert usage is not None
    assert (usage.engine, usage.model, usage.calls, usage.cost_usd) == ("jev-1.13", JEV_MODEL, 5, 0.0)
