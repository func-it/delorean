"""The HTTP API of api/openapi.yaml: the health, the catalog and the quotes,
every error an RFC 9457 problem.

FastAPI routes the requests and runs the handlers; the contract, not FastAPI,
decides every answer. FastAPI's own validation never runs — the handlers read
their headers and body themselves (body.py) — so its 422 cannot stand in for
the contract's 400, and its generated OpenAPI is off: api/openapi.yaml is the
only description of the API.
"""

import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from delorean import pipeline
from delorean.api import answers, contract, render
from delorean.api.body import REQUEST_ID, SESSION_ID, USER_ID, header, read_cart
from delorean.api.contract import Problem, ProblemCode
from delorean.api.middleware import Exchanges
from delorean.api.problems import (
    INTERNAL_DETAIL,
    ProblemError,
    exchange_of,
    problem,
    problem_error,
    problem_response,
)
from delorean.cart import MAX_QUANTITY

type Outcome = pipeline.Quote | pipeline.Rejection | BaseException
"""What a quote comes to: a quote, a refusal, or a failure."""


@dataclass(frozen=True, slots=True)
class Service:
    """What the HTTP surface serves."""

    pipeline: pipeline.Pipeline
    version: str
    """The build's, as /healthz reports it."""
    tracing: bool
    """Whether traces are exported to Langfuse."""
    prompts: Mapping[str, str]
    """The version of each prompt file, by stage."""
    max_body_bytes: int
    request_timeout: float
    """The budget of a quote, model calls included, in seconds."""

    @property
    def engines(self) -> Literal["live", "fake"]:
        return self.pipeline.engines.name

    async def health(self) -> Response:
        return _json(
            contract.Health(
                status="ok",
                implementation=contract.Implementation.python,
                version=self.version,
                engines=contract.Engines1(self.engines),
                tracing=self.tracing,
                prompts=contract.Prompts(
                    guard=self.prompts["guard"],
                    parse=self.prompts["parse"],
                    identify=self.prompts["identify"],
                    judge=self.prompts["judge"],
                ),
            )
        )

    async def catalog(self) -> Response:
        c = self.pipeline.catalog
        return _json(
            contract.Catalog(
                currency="EUR",
                films=[
                    contract.CatalogFilm(
                        id=contract.Film(v.film),
                        title=v.title,
                        volume=v.film.volume,
                        unit_price_cents=v.unit_cents,
                    )
                    for v in c.volumes
                ],
                other_film_unit_price_cents=c.other_unit_cents,
                saga_discounts=[
                    contract.SagaDiscount(distinct_volumes=t.distinct_volumes, percent=t.percent) for t in c.tiers
                ],
                limits=contract.Limits(
                    max_reading_attempts=self.pipeline.read_attempts,
                    max_body_bytes=self.max_body_bytes,
                    max_input_tokens=self.pipeline.max_input_tokens,
                    max_copies_per_title=MAX_QUANTITY,
                ),
            )
        )

    async def create_quote(self, request: Request) -> Response:
        user_id = header(request, "X-User-Id", USER_ID)
        session_id = header(request, "X-Session-Id", SESSION_ID)
        header(request, "X-Request-Id", REQUEST_ID)
        cart = await read_cart(request, self.max_body_bytes)

        request_id = exchange_of(request.scope).id
        try:
            async with asyncio.timeout(self.request_timeout):
                outcome = await self.pipeline.quote(
                    pipeline.Request(
                        cart=cart,
                        user_id=user_id,
                        session_id=session_id,
                        request_id=request_id,
                        respond=lambda outcome: render.body(self.body(outcome, request_id)).decode(),
                    )
                )
        # an engine that failed, or that did not answer within the budget
        except (pipeline.EngineError, TimeoutError) as err:
            return problem_response(request.scope, _failure(err, request_id), cause=err)

        answer = self.body(outcome, request_id)
        if isinstance(answer, Problem):
            return problem_response(request.scope, answer)
        return _json(answer)

    def body(self, outcome: Outcome, request_id: str) -> contract.Quote | Problem:
        """The body an outcome is answered with — the trace's output too, the
        same bytes the client gets."""
        threshold = self.pipeline.judge_threshold
        match outcome:
            case pipeline.Quote():
                return answers.quote(outcome, engines=self.engines, threshold=threshold)
            case pipeline.Rejection():
                rejected = answers.rejection(outcome, engines=self.engines, threshold=threshold)
                return rejected.model_copy(update={"request_id": request_id})
        return _failure(outcome, request_id)


def _failure(error: BaseException, request_id: str) -> Problem:
    """The problem a failure is answered with: 502 for an engine that failed or
    did not answer in time, 500 for anything else."""
    if isinstance(error, pipeline.EngineError | TimeoutError | asyncio.CancelledError):
        answer = problem(
            502, ProblemCode.engine_unavailable, "A model engine could not be reached, or answered out of contract."
        )
    else:
        answer = problem(500, ProblemCode.internal, INTERNAL_DETAIL)
    return answer.model_copy(update={"request_id": request_id})


def create_app(service: Service, *, log: logging.Logger | None = None) -> FastAPI:
    app = FastAPI(
        title="delorean",
        version=service.version,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
        # traces go to Langfuse, from the pipeline: no span of FastAPI's own
        telemetry={"tracing": False, "metrics": False, "logs": False, "auto_configure": False},
        # /v1/catalog/ is a path the contract does not have: 404, no redirect
        redirect_slashes=False,
    )
    app.add_api_route("/healthz", service.health, methods=["GET", "HEAD"])
    app.add_api_route("/v1/catalog", service.catalog, methods=["GET", "HEAD"])
    app.add_api_route("/v1/quotes", service.create_quote, methods=["POST"])

    app.add_exception_handler(ProblemError, problem_error)
    app.add_exception_handler(HTTPException, _unrouted)
    app.add_exception_handler(RequestValidationError, _never_validated)
    app.add_middleware(Exchanges, log=log or logging.getLogger("delorean.http"))
    return app


def _json(body: BaseModel) -> Response:
    return Response(render.body(body), media_type="application/json")


async def _unrouted(request: Request, error: Exception) -> Response:
    """404 for an unknown path, 405 with Allow for a known path under another
    method: in problem+json, where Starlette answers in plain text."""
    assert isinstance(error, HTTPException)
    path, method = request.url.path, request.method
    if error.status_code == 405:
        allow = ", ".join(sorted(m.strip() for m in (error.headers or {}).get("Allow", "").split(",")))
        answer = problem(405, ProblemCode.method_not_allowed, f"{path} answers {allow}, not {method}.")
        return problem_response(request.scope, answer, headers={"Allow": allow})
    if error.status_code == 404:
        return problem_response(request.scope, problem(404, ProblemCode.not_found, f"Nothing at {path}."))
    raise error


async def _never_validated(request: Request, error: Exception) -> Response:
    """No handler declares what FastAPI would validate; should one ever do, its
    failure is the contract's 400, not FastAPI's 422."""
    answer = problem(400, ProblemCode.malformed_request, f"request: {error}")
    return problem_response(request.scope, answer)
