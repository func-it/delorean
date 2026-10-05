"""`delorean healthcheck`, for a container with nothing but the image's own tools: a service that is up gives
exit 0 and says nothing; anything else, one line on stderr and exit 1."""

import asyncio
import os
import socket
import sys
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager

import httpx
import pytest

from delorean.healthcheck import HealthcheckError, check, port_of


def serving(status: int, body: str, asked: list[str] | None = None) -> httpx.AsyncBaseTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if asked is not None:
            asked.append(str(request.url))
        return httpx.Response(status, content=body)

    return httpx.MockTransport(handle)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


def test_it_is_silent_and_returns_when_the_service_is_up() -> None:
    check({"PORT": "24999"}, transport=serving(200, '{"status":"ok","implementation":"python"}'))


def test_it_asks_port_24792_when_port_is_not_set_and_127_0_0_1() -> None:
    asked: list[str] = []
    ok = serving(200, '{"status":"ok"}', asked)
    check({}, transport=ok)
    check({"PORT": ""}, transport=ok)
    assert asked == ["http://127.0.0.1:24792/healthz"] * 2


def test_it_fails_in_one_line_when_nothing_listens() -> None:
    port = free_port()
    with pytest.raises(HealthcheckError) as raised:
        check({"PORT": str(port)})
    assert str(raised.value) == f"healthcheck: no answer on port {port}"


def test_it_fails_on_a_status_that_is_not_200_and_on_an_answer_that_is_not_a_quoter_health() -> None:
    with pytest.raises(HealthcheckError, match=r"healthcheck: HTTP 503 on port 24999"):
        check({"PORT": "24999"}, transport=serving(503, '{"status":"ok"}'))
    with pytest.raises(HealthcheckError, match=r"healthcheck: not the health of a quoter on port 24999"):
        check({"PORT": "24999"}, transport=serving(200, "<html>not us</html>"))
    with pytest.raises(HealthcheckError, match="not the health of a quoter"):
        check({"PORT": "24999"}, transport=serving(200, '{"status":"starting"}'))
    with pytest.raises(HealthcheckError, match="not the health of a quoter"):
        check({"PORT": "24999"}, transport=serving(200, "[]"))


@pytest.mark.parametrize("port", ["abc", "0", "70000", "-1", "24792.5", " 24792", "٢٤٧٩٢"])
def test_it_refuses_a_port_that_is_not_one(port: str) -> None:
    with pytest.raises(HealthcheckError) as raised:
        port_of({"PORT": port})
    assert str(raised.value).startswith("healthcheck: PORT=")
    assert str(raised.value).endswith("is not a port")


def test_it_gives_up_after_its_time_when_the_service_does_not_answer() -> None:
    async def never(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        raise AssertionError("not cancelled")

    with pytest.raises(HealthcheckError, match=r"no answer on port 24999"):
        check({"PORT": "24999"}, timeout=0.1, transport=httpx.MockTransport(never))


@asynccontextmanager
async def service(status: int, body: str) -> AsyncIterator[int]:
    """A service on a free port, on this loop, answering /healthz with `status` and `body`."""

    async def answer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        payload = body.encode()
        head = f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n"
        writer.write(f"{head}Connection: close\r\n\r\n".encode() + payload)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(answer, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        server.close()
        await server.wait_closed()


async def run(args: list[str], env: Mapping[str, str]) -> tuple[int | None, str, str]:
    """The command as a process of its own — not a blocking call: this loop must answer it."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "delorean",
        *args,
        env={"PATH": os.environ.get("PATH", ""), **env},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate()
    return process.returncode, out.decode(), err.decode()


async def test_the_command_exits_0_and_prints_nothing_when_the_service_is_up_whatever_else_is_configured() -> None:
    async with service(200, '{"status":"ok"}') as port:
        # a setting that would fail the service's own configuration must not fail the check
        result = await run(["healthcheck"], {"PORT": str(port), "REQUEST_TIMEOUT": "nonsense", "ENGINES": "nope"})
    assert result == (0, "", "")


async def test_the_command_exits_1_with_one_line_on_stderr_when_nothing_listens() -> None:
    port = free_port()
    assert await run(["healthcheck"], {"PORT": str(port)}) == (
        1,
        "",
        f"delorean: healthcheck: no answer on port {port}\n",
    )


async def test_the_command_exits_2_on_a_command_it_does_not_know_and_says_the_commands() -> None:
    assert await run(["help"], {}) == (
        2,
        "",
        'delorean: unknown command "help": want serve, healthcheck, version or tokenizer\n',
    )
