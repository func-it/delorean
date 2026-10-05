"""The suite's guard against the network (conftest.no_network)."""

import socket

import pytest


def test_a_name_that_is_not_local_is_not_looked_up() -> None:
    with pytest.raises(socket.gaierror, match="a test went to the network"):
        socket.getaddrinfo("openrouter.ai", 443)


def test_a_connection_beyond_the_machine_is_refused() -> None:
    with socket.socket() as sock, pytest.raises(OSError, match="a test went to the network"):
        sock.connect(("203.0.113.7", 443))


def test_the_machine_itself_is_reachable() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        with socket.socket() as client:
            client.connect(server.getsockname())
