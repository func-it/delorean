"""The command line, and a real server on fake engines."""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from delorean.__main__ import main


def test_version(capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DELOREAN_VERSION", raising=False)
    assert main(["version"]) == 0
    assert capsys.readouterr().out.strip() == "dev"
    monkeypatch.setenv("DELOREAN_VERSION", "v1.2.0-3-gabc1234")
    assert main(["version"]) == 0
    assert capsys.readouterr().out.strip() == "v1.2.0-3-gabc1234"


def test_unknown_command(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["fly"]) == 2
    assert capsys.readouterr().err == 'delorean: unknown command "fly": want serve, version or tokenizer\n'


def test_an_extra_argument_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["version", "now"]) == 2
    assert capsys.readouterr().err == 'delorean: unexpected argument "now"\n'


def test_tokenizer_says_how_many_ranks(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["tokenizer"]) == 0
    assert capsys.readouterr().out == "o200k_base: 199998 ranks\n"


def test_a_wrong_configuration_stops_the_start(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENGINES", "fake")
    monkeypatch.setenv("PORT", "0")
    monkeypatch.setenv("JUDGE_THRESHOLD", "2")
    assert main(["serve"]) == 1
    err = capsys.readouterr().err
    assert "PORT must be between 1 and 65535" in err
    assert "JUDGE_THRESHOLD must be between 0 and 1" in err


def test_a_missing_tokenizer_stops_the_start(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ENGINES", "fake")
    monkeypatch.setenv("TIKTOKEN_CACHE_DIR", str(tmp_path))
    assert main(["serve"]) == 1
    assert "delorean tokenizer" in capsys.readouterr().err


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


def test_serve() -> None:
    """The service as it runs: a process on the fake engines, its JSON logs,
    and a graceful stop on SIGTERM."""
    port = free_port()
    env = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
    process = subprocess.Popen(
        [sys.executable, "-m", "delorean", "serve"],
        env={**env, "ENGINES": "fake", "PORT": str(port)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}") as client:
            for _ in range(200):
                try:
                    health = client.get("/healthz")
                    break
                except httpx.ConnectError:
                    time.sleep(0.05)
            assert health.json()["engines"] == "fake"
            quote = client.post("/v1/quotes", json={"cart": "Back to the Future 1\nBack to the Future 3"})
            assert quote.json()["total_cents"] == 2700
    finally:
        process.send_signal(signal.SIGTERM)
        out, _ = process.communicate(timeout=10)
    assert process.returncode == 0, out
    lines = out.splitlines()
    assert all(line == json.dumps(json.loads(line), separators=(",", ":"), ensure_ascii=False) for line in lines)
    logs = [json.loads(line) for line in lines]
    assert [entry["msg"] for entry in logs] == [
        "fake engines: deterministic stand-ins for tests, never in production",
        "listening",
        "request",
        "request",
        "shutting down",
    ], "these lines and no other: no uvicorn line"
    listening = logs[1]
    assert list(listening) == ["time", "level", "msg", "addr", "version", "engines", "tracing", "prompts"]
    assert (listening["addr"], listening["engines"], listening["tracing"]) == (f":{port}", "fake", False)
    assert set(listening["prompts"]) == {"guard", "parse", "identify", "judge"}, "as /healthz serves them"
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", listening["time"])
    assert (logs[-1]["level"], logs[-1]["signal"]) == ("INFO", "SIGTERM")
    request = logs[3]
    assert (request["method"], request["path"], request["status"]) == ("POST", "/v1/quotes", 200)
