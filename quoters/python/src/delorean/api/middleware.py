"""What every request goes through: an id, one log line once answered, and a
500 problem for an exception no handler caught."""

import base64
import logging
import secrets
import time

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from delorean.api.body import REQUEST_ID
from delorean.api.contract import ProblemCode
from delorean.api.problems import INTERNAL_DETAIL, Exchange, problem, problem_response


class Exchanges:
    """Gives every request an id — the client's X-Request-Id when it has the
    contract's format, a new one otherwise — echoed on the response; logs the
    request in one line once answered; answers an unhandled exception with a
    500 problem, its cause logged and never shown.

    A pure ASGI middleware: it sees the response as it is sent, its status
    and its size, and the exceptions Starlette's handlers leave."""

    def __init__(self, app: ASGIApp, *, log: logging.Logger) -> None:
        self.app = app
        self.log = log

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        given = Headers(scope=scope).get("x-request-id", "")
        exchange = Exchange(id=given if REQUEST_ID.fullmatch(given) else _new_id())
        scope.setdefault("state", {})["exchange"] = exchange
        started = time.perf_counter()
        status = size = 0

        async def sending(message: Message) -> None:
            nonlocal status, size
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-Id"] = exchange.id
            elif message["type"] == "http.response.body":
                size += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, sending)
        except Exception as err:  # noqa: BLE001 — whatever it is, the client gets a 500 problem
            if status:  # the answer is under way: all that is left is to log why
                exchange.cause = err
            else:
                answer = problem(500, ProblemCode.internal, INTERNAL_DETAIL)
                await problem_response(scope, answer, cause=err)(scope, receive, sending)
        finally:
            self._log(scope, exchange, status, size, time.perf_counter() - started)

    def _log(self, scope: Scope, exchange: Exchange, status: int, size: int, took: float) -> None:
        fields: dict[str, object] = {
            "request_id": exchange.id,
            "method": scope["method"],
            "path": scope["path"],
            "status": status,  # 0: no answer, the client went away
            "ms": int(took * 1000),
            "bytes": size,
        }
        if exchange.code:
            fields["code"] = exchange.code.value
        if exchange.cause:
            fields["err"] = str(exchange.cause) or type(exchange.cause).__name__
        level = logging.ERROR if status >= 500 else logging.INFO
        trace = exchange.cause if status == 500 else None  # a bug: where it happened
        self.log.log(level, "request", extra=fields, exc_info=trace)


def _new_id() -> str:
    """26 base32 characters, 128 random bits."""
    return base64.b32encode(secrets.token_bytes(16)).decode().rstrip("=")
