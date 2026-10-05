"""Errors as RFC 9457 problems, each with a stable code, and what the
middleware and the handlers share about a request to log it."""

from dataclasses import dataclass
from typing import Final

from fastapi import Request
from fastapi.responses import Response
from starlette.types import Scope

from delorean.api import render
from delorean.api.contract import Problem, ProblemCode

PROBLEM_JSON: Final = "application/problem+json"

TITLES: Final = {
    ProblemCode.malformed_request: "Malformed request",
    ProblemCode.payload_too_large: "Payload too large",
    ProblemCode.empty_cart: "Cart rejected",
    ProblemCode.too_long: "Cart rejected",
    ProblemCode.injection: "Cart rejected",
    ProblemCode.invalid_request: "Cart rejected",
    ProblemCode.no_film: "Cart rejected",
    ProblemCode.quantity_too_large: "Cart rejected",
    ProblemCode.unfaithful_reading: "Cart rejected",
    ProblemCode.engine_unavailable: "Engine unavailable",
    ProblemCode.quantity_unverified: "Quantities not verified",
    ProblemCode.not_found: "Not found",
    ProblemCode.method_not_allowed: "Method not allowed",
    ProblemCode.internal: "Internal error",
}

INTERNAL_DETAIL: Final = "Something went wrong on our side; the request id tells us where."


def problem(status: int, code: ProblemCode, detail: str) -> Problem:
    return Problem(type=f"/problems/{code}", title=TITLES[code], status=status, code=code, detail=detail)


@dataclass(slots=True)
class Exchange:
    """One request: its id, and how it ended, for the log line."""

    id: str
    code: ProblemCode | None = None
    """The problem answered, if any."""
    cause: BaseException | None = None
    """What went wrong behind a 5xx: logged, never shown."""
    degraded: bool = False
    """A stage failed and the answer, a quote or a refusal, was made without it
    (the recount): said in the log line."""


def exchange_of(scope: Scope) -> Exchange:
    exchange = scope.get("state", {}).get("exchange")
    if not isinstance(exchange, Exchange):
        raise RuntimeError("no exchange: the request did not go through the middleware")
    return exchange


class ProblemError(Exception):
    """Raised by a handler to answer with a problem."""

    def __init__(self, status: int, code: ProblemCode, detail: str) -> None:
        super().__init__(detail)
        self.problem = problem(status, code, detail)


def problem_response(
    scope: Scope,
    answer: Problem,
    *,
    cause: BaseException | None = None,
    headers: dict[str, str] | None = None,
) -> Response:
    """The answer with a problem, which carries the request's id. cause is
    what went wrong behind it: logged, never shown."""
    exchange = exchange_of(scope)
    exchange.code, exchange.cause = answer.code, cause
    body = answer.model_copy(update={"request_id": exchange.id})
    return Response(render.body(body), status_code=answer.status, media_type=PROBLEM_JSON, headers=headers)


async def problem_error(request: Request, error: Exception) -> Response:
    """The exception handler of ProblemError."""
    assert isinstance(error, ProblemError)
    return problem_response(request.scope, error.problem)
