"""Settings from the environment: the defaults of docs/architecture.md, and
every mistake said at once."""

from pathlib import Path

import pytest

from delorean.config import (
    PROJECT_DIR,
    REPO_DIR,
    ConfigError,
    LangfuseSettings,
    LiveSettings,
    Settings,
    go_duration,
)


def test_defaults() -> None:
    s = Settings.from_env({"OPENROUTER_API_KEY": "k"})
    assert s == Settings(
        port=24792,
        engines="live",
        live=LiveSettings(
            openrouter_api_key="k",
            parse_model="openai/gpt-6-luna",
            parse_effort="minimal",
            parse_base_url="https://openrouter.ai/api/v1",
            parse_identifies=False,
            recount_model="openai/gpt-6-luna",
            recount_effort="none",
            jev_model="typesafe/jev-1.13",
            identify_cache_size=10_000,
            model_timeout=6.0,
        ),
        max_body_bytes=8192,
        max_input_tokens=256,
        guard_min_confidence=0.5,
        judge_threshold=0.5,
        read_attempts=3,
        recount_timeout=6.0,
        request_timeout=15.0,
        fake_latency="off",
        fake_cpu_ms=0,
        prompts_dir=REPO_DIR / "prompts",
        tokenizer_dir=PROJECT_DIR / ".tiktoken",
        langfuse=None,
    )
    assert (REPO_DIR / "prompts" / "parse.json").is_file()
    assert (PROJECT_DIR / "pyproject.toml").is_file()


def test_every_variable() -> None:
    s = Settings.from_env(
        {
            "PORT": "9081",
            "ENGINES": "fake",
            "PARSE_MODEL": "openai/gpt-6",
            "PARSE_EFFORT": "medium",
            "PARSE_BASE_URL": "http://localhost:11434/v1",
            "PARSE_IDENTIFIES": "true",
            "RECOUNT_BASE_URL": "http://localhost:11434/v1",
            "RECOUNT_MODEL": "mistralai/mistral-small",
            "RECOUNT_EFFORT": "minimal",
            "JEV_MODEL": "typesafe/jev-2.0",
            "IDENTIFY_CACHE_SIZE": "0",
            "MODEL_TIMEOUT": "4s",
            "RECOUNT_TIMEOUT": "2500ms",
            "MAX_BODY_BYTES": "1024",
            "MAX_INPUT_TOKENS": "512",
            "GUARD_MIN_CONFIDENCE": "0.7",
            "JUDGE_THRESHOLD": "0.6",
            "READ_ATTEMPTS": "5",
            "REQUEST_TIMEOUT": "1m30s",
            "PROMPTS_DIR": "/srv/prompts",
            "TIKTOKEN_CACHE_DIR": "/srv/tiktoken",
            "LANGFUSE_PUBLIC_KEY": "pk",
            "LANGFUSE_SECRET_KEY": "sk",
            "LANGFUSE_BASE_URL": "http://localhost:24794/",
        }
    )
    assert (s.port, s.engines, s.max_body_bytes, s.max_input_tokens) == (9081, "fake", 1024, 512)
    assert (s.guard_min_confidence, s.judge_threshold, s.request_timeout) == (0.7, 0.6, 90.0)
    assert (s.read_attempts, s.recount_timeout) == (5, 2.5)
    assert s.live == LiveSettings(
        openrouter_api_key="",
        parse_model="openai/gpt-6",
        parse_effort="medium",
        parse_base_url="http://localhost:11434/v1",
        parse_identifies=True,
        recount_model="mistralai/mistral-small",
        recount_effort="minimal",
        recount_base_url="http://localhost:11434/v1",
        jev_model="typesafe/jev-2.0",
        identify_cache_size=0,
        model_timeout=4.0,
    )
    assert (s.prompts_dir, s.tokenizer_dir) == (Path("/srv/prompts"), Path("/srv/tiktoken"))
    assert s.langfuse == LangfuseSettings(public_key="pk", secret_key="sk", base_url="http://localhost:24794")


def test_the_key_is_required_with_live_engines_only() -> None:
    with pytest.raises(ConfigError, match="OPENROUTER_API_KEY is required with ENGINES=live"):
        Settings.from_env({})
    assert Settings.from_env({"ENGINES": "fake"}).engines == "fake"


def test_every_mistake_at_once() -> None:
    with pytest.raises(ConfigError) as raised:
        Settings.from_env(
            {
                "ENGINES": "mock",
                "PORT": "eighty",
                "MAX_BODY_BYTES": "0",
                "MAX_INPUT_TOKENS": "-1",
                "GUARD_MIN_CONFIDENCE": "1.5",
                "JUDGE_THRESHOLD": "half",
                "READ_ATTEMPTS": "0",
                "MODEL_TIMEOUT": "0",
                "RECOUNT_TIMEOUT": "6",
                "REQUEST_TIMEOUT": "30",
                "PARSE_EFFORT": "extreme",
                "LANGFUSE_PUBLIC_KEY": "pk",
            }
        )
    assert str(raised.value).splitlines() == [
        'PORT="eighty" is not an integer',
        'ENGINES is "mock", want live or fake',
        'PARSE_EFFORT is "extreme", want one of none, minimal, low, medium, high',
        "MAX_BODY_BYTES must be at least 1",
        "MAX_INPUT_TOKENS must be at least 1",
        "GUARD_MIN_CONFIDENCE must be between 0 and 1",
        'JUDGE_THRESHOLD="half" is not a number',
        "READ_ATTEMPTS must be at least 1",
        "MODEL_TIMEOUT must be positive",
        'RECOUNT_TIMEOUT="6" is not a duration such as "30s"',
        'REQUEST_TIMEOUT="30" is not a duration such as "30s"',
        "Langfuse is half configured: LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL (or LANGFUSE_HOST) missing",
    ]


@pytest.mark.parametrize(
    ("env", "line"),
    [
        ({"IDENTIFY_CACHE_SIZE": "-1"}, "IDENTIFY_CACHE_SIZE must be at least 0 (0 turns the cache off)"),
        ({"PARSE_BASE_URL": "ftp://x"}, 'PARSE_BASE_URL is "ftp://x", not an http(s) URL'),
        ({"PORT": "1_000"}, 'PORT="1_000" is not an integer'),
        (
            {"LANGFUSE_HOST": "http://h:3000"},
            "Langfuse is half configured: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY missing",
        ),
        (
            {"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk", "LANGFUSE_HOST": "localhost:3000"},
            'LANGFUSE_BASE_URL is "localhost:3000", not an http(s) URL',
        ),
    ],
)
def test_the_words_of_every_quoter(env: dict[str, str], line: str) -> None:
    with pytest.raises(ConfigError) as raised:
        Settings.from_env({"ENGINES": "fake", **env})
    assert str(raised.value).splitlines() == [line]


@pytest.mark.parametrize(("value", "parsed"), [("1", True), ("T", True), ("False", False), ("0", False)])
def test_booleans_as_go_reads_them(value: str, parsed: bool) -> None:
    assert Settings.from_env({"ENGINES": "fake", "PARSE_IDENTIFIES": value}).live.parse_identifies is parsed


def test_langfuse_host_is_a_url() -> None:
    s = Settings.from_env(
        {"ENGINES": "fake", "LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk", "LANGFUSE_HOST": "http://h:3000/"}
    )
    assert s.langfuse is not None
    assert s.langfuse.base_url == "http://h:3000"


def test_secrets_stay_out_of_reprs() -> None:
    s = Settings.from_env(
        {
            "OPENROUTER_API_KEY": "sk-or-secret",
            "LANGFUSE_PUBLIC_KEY": "pk",
            "LANGFUSE_SECRET_KEY": "sk-lf-secret",
            "LANGFUSE_HOST": "http://localhost:3000",
        }
    )
    assert "secret" not in repr(s)


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("30s", 30),
        ("1m30s", 90),
        ("1.5s", 1.5),
        ("500ms", 0.5),
        ("2h", 7200),
        ("0", 0),
        ("+5s", 5),
        ("1h1m1s", 3661),
    ],
)
def test_go_duration(text: str, seconds: float) -> None:
    assert go_duration(text) == pytest.approx(seconds)


@pytest.mark.parametrize("text", ["", "30", "s", "30 s", "1d", "1m-30s", "thirty seconds"])
def test_go_duration_refuses(text: str) -> None:
    with pytest.raises(ValueError, match="duration"):
        go_duration(text)


def test_reader_endpoints_and_options_are_checked() -> None:
    with pytest.raises(ConfigError) as raised:
        Settings.from_env(
            {
                "ENGINES": "fake",
                "PARSE_BASE_URL": "localhost:11434",
                "PARSE_IDENTIFIES": "maybe",
                "RECOUNT_EFFORT": "max",
            }
        )
    assert str(raised.value).splitlines() == [
        'PARSE_BASE_URL is "localhost:11434", not an http(s) URL',
        'PARSE_IDENTIFIES="maybe" is not true or false',
        'RECOUNT_EFFORT is "max", want one of none, minimal, low, medium, high',
    ]


def test_one_line_per_variable() -> None:
    with pytest.raises(ConfigError) as raised:
        Settings.from_env({"PORT": "0", "ENGINES": "fake", "PARSE_BASE_URL": "x", "PARSE_EFFORT": "max"})
    assert str(raised.value).splitlines() == [
        "PORT must be between 1 and 65535",
        'PARSE_EFFORT is "max", want one of none, minimal, low, medium, high',
        'PARSE_BASE_URL is "x", not an http(s) URL',
    ]


def test_fake_latency_and_cpu() -> None:
    s = Settings.from_env({"ENGINES": "fake", "FAKE_LATENCY": "real", "FAKE_CPU_MS": "5"})
    assert (s.fake_latency, s.fake_cpu_ms) == ("real", 5)
    with pytest.raises(ConfigError) as raised:
        Settings.from_env({"ENGINES": "fake", "FAKE_LATENCY": "slow", "FAKE_CPU_MS": "-1", "REQUEST_TIMEOUT": "x"})
    assert str(raised.value).splitlines() == [
        'REQUEST_TIMEOUT="x" is not a duration such as "30s"',
        'FAKE_LATENCY is "slow", want off or real',
        "FAKE_CPU_MS must be at least 0",
    ]
    with pytest.raises(ConfigError, match='FAKE_CPU_MS="many" is not an integer'):
        Settings.from_env({"ENGINES": "fake", "FAKE_CPU_MS": "many"})
