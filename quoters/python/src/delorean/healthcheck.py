"""Asks the service on this machine for /healthz, for a container that is
asked to do it with what the image has (compose's healthcheck runs this
command). It reads PORT, as the service does, and nothing else: it must not
fail on a setting the service accepted. Up is a 200 with the health JSON, said
by nothing at all; anything else is a HealthcheckError of one short line."""

import asyncio
import json
import re
from collections.abc import Mapping

import httpx

PORT: int = 24792
"""Where the service listens when PORT is not set."""
TIMEOUT: float = 3.0
"""Seconds the whole check has."""


class HealthcheckError(Exception):
    """The service is not up: one line, `healthcheck: …`."""


def port_of(env: Mapping[str, str]) -> int:
    given = env.get("PORT", "")
    if not given:
        return PORT
    # ASCII digits and nothing else: no sign, no point, no blank, no other script's digits
    if not re.fullmatch(r"[0-9]+", given) or not 1 <= int(given) <= 65535:
        raise HealthcheckError(f"healthcheck: PORT={_quoted(given)} is not a port")
    return int(given)


def check(
    env: Mapping[str, str], *, timeout: float = TIMEOUT, transport: httpx.AsyncBaseTransport | None = None
) -> None:
    """Returns when the service on PORT answers 200 with its health; raises
    HealthcheckError otherwise."""
    port = port_of(env)
    asyncio.run(_ask(port, timeout, transport))


async def _ask(port: int, budget: float, transport: httpx.AsyncBaseTransport | None) -> None:
    try:
        # the whole call, not each phase of it
        async with asyncio.timeout(budget), httpx.AsyncClient(transport=transport) as client:
            response = await client.get(f"http://127.0.0.1:{port}/healthz")
    except TimeoutError, httpx.HTTPError:
        raise HealthcheckError(f"healthcheck: no answer on port {port}") from None
    if response.status_code != httpx.codes.OK:
        raise HealthcheckError(f"healthcheck: HTTP {response.status_code} on port {port}")
    try:
        health = response.json()
    except ValueError:
        health = None
    if not isinstance(health, dict) or health.get("status") != "ok":
        raise HealthcheckError(f"healthcheck: not the health of a quoter on port {port}")


def _quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)
