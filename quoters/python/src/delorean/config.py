"""The service's settings, read from the environment (docs/architecture.md,
"Configuration"), with everything that is wrong with them said at once,
before anything starts."""

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Final, Literal
from urllib.parse import urlsplit

_HERE: Final = Path(__file__).resolve()
PROJECT_DIR: Final = _HERE.parents[2]
"""quoters/python, when delorean runs from its source tree."""
REPO_DIR: Final = _HERE.parents[4]


type Effort = Literal["none", "minimal", "low", "medium", "high"]
"""A reasoning effort; `none` sends no reasoning field, which a model without
reasoning refuses."""

OPENROUTER: Final = "https://openrouter.ai/api/v1"


class ConfigError(ValueError):
    """Every variable that is wrong, one per line."""


@dataclass(frozen=True, slots=True)
class LiveSettings:
    """What the live engines need."""

    openrouter_api_key: str = field(repr=False)
    parse_model: str = "openai/gpt-6-luna"
    parse_effort: Effort = "minimal"
    parse_base_url: str = OPENROUTER
    """The parse's OpenAI-compatible API: OpenRouter, or a local server such as
    Ollama, to bench it."""
    parse_identifies: bool = False
    """The parse gives each line its film too (prompts/parse-films.json), and
    identify skips those titles."""
    recount_model: str = "openai/gpt-6-luna"
    """The recount: the parse's model by default, without reasoning, for a
    second reading that does not keep the customer waiting."""
    recount_effort: Effort = "none"
    recount_base_url: str = OPENROUTER
    jev_model: str = "typesafe/jev-1.13"
    identify_cache_size: int = 10_000
    """Titles whose film is kept in memory; 0 turns the cache off."""
    model_timeout: float = 6.0
    """Seconds one model call may take, Jev's and the LLMs': one that
    outlasts it fails as an engine does."""


@dataclass(frozen=True, slots=True)
class LangfuseSettings:
    public_key: str
    secret_key: str = field(repr=False)
    base_url: str
    """Where the public API answers: "https://cloud.langfuse.com"."""


@dataclass(frozen=True, slots=True)
class Settings:
    port: int = 24792
    engines: Literal["live", "fake"] = "live"
    """live, the models through OpenRouter, or fake, deterministic stand-ins
    for tests."""
    live: LiveSettings = field(default_factory=lambda: LiveSettings(openrouter_api_key=""))
    max_body_bytes: int = 8192
    max_input_tokens: int = 256
    guard_min_confidence: float = 0.5
    judge_threshold: float = 0.5
    read_attempts: int = 3
    """The most readings of one cart before unfaithful_reading."""
    recount_timeout: float = 6.0
    """Seconds the recount has, a retry included, before the quote goes on
    without it (degraded)."""
    request_timeout: float = 15.0
    """The budget of one request, model calls included, in seconds."""
    fake_latency: Literal["off", "real"] = "off"
    """`real`: the fake engines take a model's time, for the load bench."""
    fake_cpu_ms: int = 0
    """Milliseconds of busy processor per fake call."""
    prompts_dir: Path = REPO_DIR / "prompts"
    tokenizer_dir: Path = PROJECT_DIR / ".tiktoken"
    """Where the tokenizer's vocabulary is cached (TIKTOKEN_CACHE_DIR)."""
    langfuse: LangfuseSettings | None = None
    """Traces go to Langfuse when set."""

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        """Reads the settings from env, os.environ but in tests. Raises
        ConfigError naming every variable that is wrong, in the words and the
        order of every quoter (docs/architecture.md, "Identical quoters")."""
        read = _Reader(env)
        defaults = cls()
        port = read.parsed("PORT", defaults.port, _int, "an integer")
        engines = read.text("ENGINES", defaults.engines)
        parse_effort = read.text("PARSE_EFFORT", defaults.live.parse_effort)
        recount_effort = read.text("RECOUNT_EFFORT", defaults.live.recount_effort)
        fake_latency = read.text("FAKE_LATENCY", defaults.fake_latency)
        live = LiveSettings(
            openrouter_api_key=env.get("OPENROUTER_API_KEY", ""),
            parse_model=read.text("PARSE_MODEL", defaults.live.parse_model),
            parse_effort=_effort(parse_effort),
            parse_base_url=read.text("PARSE_BASE_URL", defaults.live.parse_base_url),
            parse_identifies=read.parsed("PARSE_IDENTIFIES", defaults.live.parse_identifies, _bool, "true or false"),
            recount_model=read.text("RECOUNT_MODEL", defaults.live.recount_model),
            recount_effort=_effort(recount_effort),
            recount_base_url=read.text("RECOUNT_BASE_URL", defaults.live.recount_base_url),
            jev_model=read.text("JEV_MODEL", defaults.live.jev_model),
            identify_cache_size=read.parsed(
                "IDENTIFY_CACHE_SIZE", defaults.live.identify_cache_size, _int, "an integer"
            ),
            model_timeout=read.parsed(
                "MODEL_TIMEOUT", defaults.live.model_timeout, go_duration, 'a duration such as "30s"'
            ),
        )
        settings = cls(
            port=port,
            engines="fake" if engines == "fake" else "live",
            live=live,
            max_body_bytes=read.parsed("MAX_BODY_BYTES", defaults.max_body_bytes, _int, "an integer"),
            max_input_tokens=read.parsed("MAX_INPUT_TOKENS", defaults.max_input_tokens, _int, "an integer"),
            guard_min_confidence=read.parsed("GUARD_MIN_CONFIDENCE", defaults.guard_min_confidence, float, "a number"),
            judge_threshold=read.parsed("JUDGE_THRESHOLD", defaults.judge_threshold, float, "a number"),
            read_attempts=read.parsed("READ_ATTEMPTS", defaults.read_attempts, _int, "an integer"),
            recount_timeout=read.parsed(
                "RECOUNT_TIMEOUT", defaults.recount_timeout, go_duration, 'a duration such as "30s"'
            ),
            request_timeout=read.parsed(
                "REQUEST_TIMEOUT", defaults.request_timeout, go_duration, 'a duration such as "30s"'
            ),
            fake_latency="real" if fake_latency == "real" else "off",
            fake_cpu_ms=read.parsed("FAKE_CPU_MS", defaults.fake_cpu_ms, _int, "an integer"),
            prompts_dir=Path(read.text("PROMPTS_DIR", str(defaults.prompts_dir))),
            tokenizer_dir=tokenizer_dir(env),
        )

        read.check(1 <= settings.port <= 65535, "PORT", "must be between 1 and 65535")
        read.check(settings.max_body_bytes >= 1, "MAX_BODY_BYTES", "must be at least 1")
        read.check(settings.max_input_tokens >= 1, "MAX_INPUT_TOKENS", "must be at least 1")
        read.check(0 <= settings.guard_min_confidence <= 1, "GUARD_MIN_CONFIDENCE", "must be between 0 and 1")
        read.check(0 <= settings.judge_threshold <= 1, "JUDGE_THRESHOLD", "must be between 0 and 1")
        read.check(settings.read_attempts >= 1, "READ_ATTEMPTS", "must be at least 1")
        read.check(live.identify_cache_size >= 0, "IDENTIFY_CACHE_SIZE", "must be at least 0 (0 turns the cache off)")
        for name, effort in (("PARSE_EFFORT", parse_effort), ("RECOUNT_EFFORT", recount_effort)):
            read.check(effort in EFFORTS, name, f"is {_quoted(effort)}, want one of {', '.join(EFFORTS)}")
        for name, url in (("PARSE_BASE_URL", live.parse_base_url), ("RECOUNT_BASE_URL", live.recount_base_url)):
            read.check(_http_url(url), name, f"is {_quoted(url)}, not an http(s) URL")
            # with live engines the key goes along with every call: over http it would cross the network in
            # the clear, so http is for the local machine only (a variable already wrong is not told twice)
            if not read.bad(name) and engines == "live" and urlsplit(url).scheme == "http" and not _is_localhost(url):
                read.wrong(
                    name, f"{name} is {_quoted(url)}, not https: a key is sent with it (http is for localhost only)"
                )
        read.check(settings.request_timeout > 0, "REQUEST_TIMEOUT", "must be positive")
        read.check(settings.recount_timeout > 0, "RECOUNT_TIMEOUT", "must be positive")
        read.check(live.model_timeout > 0, "MODEL_TIMEOUT", "must be positive")
        # a call is bounded by the recount's time, which the request's time bounds in turn;
        # a variable that failed its own check is not compared
        if not read.bad("MODEL_TIMEOUT") and not read.bad("RECOUNT_TIMEOUT"):
            read.check(
                settings.recount_timeout >= live.model_timeout, "RECOUNT_TIMEOUT", "must be at least MODEL_TIMEOUT"
            )
        if not read.bad("RECOUNT_TIMEOUT") and not read.bad("REQUEST_TIMEOUT"):
            read.check(
                settings.request_timeout >= settings.recount_timeout,
                "REQUEST_TIMEOUT",
                "must be at least RECOUNT_TIMEOUT",
            )
        read.check(fake_latency in {"off", "real"}, "FAKE_LATENCY", f"is {_quoted(fake_latency)}, want off or real")
        read.check(settings.fake_cpu_ms >= 0, "FAKE_CPU_MS", "must be at least 0")
        match engines:
            case "fake":
                pass
            case "live":
                read.check(
                    bool(live.openrouter_api_key),
                    "OPENROUTER_API_KEY",
                    "is required with ENGINES=live; set it, or run ENGINES=fake for the deterministic test engines",
                )
            case _:
                read.wrong("ENGINES", f"ENGINES is {_quoted(engines)}, want live or fake")
        settings = replace(settings, langfuse=read.langfuse())
        if read.errors:
            raise ConfigError("\n".join(read.errors))
        return settings


def tokenizer_dir(env: Mapping[str, str]) -> Path:
    """TIKTOKEN_CACHE_DIR, the variable tiktoken itself reads, or the
    project's .tiktoken."""
    return Path(env.get("TIKTOKEN_CACHE_DIR") or PROJECT_DIR / ".tiktoken")


ORDER: Final = (
    "PORT",
    "ENGINES",
    "OPENROUTER_API_KEY",
    "PARSE_MODEL",
    "PARSE_EFFORT",
    "PARSE_BASE_URL",
    "PARSE_IDENTIFIES",
    "RECOUNT_MODEL",
    "RECOUNT_EFFORT",
    "RECOUNT_BASE_URL",
    "JEV_MODEL",
    "MAX_BODY_BYTES",
    "MAX_INPUT_TOKENS",
    "GUARD_MIN_CONFIDENCE",
    "JUDGE_THRESHOLD",
    "READ_ATTEMPTS",
    "IDENTIFY_CACHE_SIZE",
    "MODEL_TIMEOUT",
    "RECOUNT_TIMEOUT",
    "REQUEST_TIMEOUT",
    "FAKE_LATENCY",
    "FAKE_CPU_MS",
    "LANGFUSE",
)
"""The order of the configuration table, which the errors follow; Langfuse
last."""


class _Reader:
    """Reads typed variables and collects what is wrong with them: one line
    per variable, the first problem found."""

    def __init__(self, env: Mapping[str, str]) -> None:
        self.env = env
        self._errors: dict[str, str] = {}

    @property
    def errors(self) -> list[str]:
        return [self._errors[name] for name in ORDER if name in self._errors]

    def wrong(self, name: str, line: str) -> None:
        self._errors.setdefault(name, line)

    def check(self, ok: bool, name: str, problem: str) -> None:  # noqa: FBT001
        if not ok:
            self.wrong(name, f"{name} {problem}")

    def bad(self, name: str) -> bool:
        """Whether name already failed a check of its own."""
        return name in self._errors

    def text(self, name: str, default: str) -> str:
        return self.env.get(name) or default

    def parsed[T](self, name: str, default: T, parse: Callable[[str], T], want: str) -> T:
        value = self.env.get(name)
        if not value:
            return default
        try:
            return parse(value)
        except ValueError:
            self.wrong(name, f"{name}={_quoted(value)} is not {want}")
            return default

    def langfuse(self) -> LangfuseSettings | None:
        """LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL — or
        LANGFUSE_HOST, a URL too, as the Langfuse SDKs read it. None when none
        is set; a partial setting is an error, not a silent no-op."""
        public_key = self.env.get("LANGFUSE_PUBLIC_KEY", "")
        secret_key = self.env.get("LANGFUSE_SECRET_KEY", "")
        base_url = (self.env.get("LANGFUSE_BASE_URL") or self.env.get("LANGFUSE_HOST") or "").rstrip("/")
        if not (public_key or secret_key or base_url):
            return None
        missing = [
            name
            for name, value in (
                ("LANGFUSE_PUBLIC_KEY", public_key),
                ("LANGFUSE_SECRET_KEY", secret_key),
                ("LANGFUSE_BASE_URL (or LANGFUSE_HOST)", base_url),
            )
            if not value
        ]
        if missing:
            listed = ", ".join(missing[:-1]) + " and " + missing[-1] if len(missing) > 1 else missing[0]
            self.wrong("LANGFUSE", f"Langfuse is half configured: {listed} missing")
            return None
        if not _http_url(base_url):
            self.wrong("LANGFUSE", f"LANGFUSE_BASE_URL is {_quoted(base_url)}, not an http(s) URL")
            return None
        return LangfuseSettings(public_key=public_key, secret_key=secret_key, base_url=base_url)


EFFORTS: Final = ("none", "minimal", "low", "medium", "high")


def _effort(value: str) -> Effort:
    """value as an effort; one out of EFFORTS is reported by the checks."""
    match value:
        case "none" | "minimal" | "low" | "medium" | "high":
            return value
    return "low"


def _int(value: str) -> int:
    """An integer as Go's strconv.Atoi reads one: digits, a sign at most."""
    if not re.fullmatch(r"[+-]?[0-9]+", value):
        raise ValueError(value)
    return int(value)


def _bool(value: str) -> bool:
    """A boolean as Go's strconv.ParseBool reads one."""
    if value in {"1", "t", "T", "TRUE", "true", "True"}:
        return True
    if value in {"0", "f", "F", "FALSE", "false", "False"}:
        return False
    raise ValueError(value)


def _quoted(value: str) -> str:
    """A value in double quotes, as every quoter writes it in an error."""
    return json.dumps(value, ensure_ascii=False)


def _http_url(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme in {"http", "https"} and bool(parts.hostname)


def _is_localhost(url: str) -> bool:
    """Whether the URL's host is the local machine, by exactly these names: as written, as Go reads it (a URL
    parser lower-cases the host, and `LOCALHOST` is not `localhost` here)."""
    match = re.match(r"[^:/?#]+://(?:[^/?#@]*@)?(\[[^\]]*\]|[^:/?#]*)", url)
    host = match[1] if match else ""
    name = host[1:-1] if host.startswith("[") else host
    return name in {"localhost", "127.0.0.1", "::1"}


_DURATION: Final = re.compile(r"(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)")
_UNITS: Final = {  # in milliseconds, exact: a fraction of a millisecond rounds as Go rounds it
    "ns": Decimal("0.000001"),
    "us": Decimal("0.001"),
    "µs": Decimal("0.001"),
    "μs": Decimal("0.001"),
    "ms": Decimal(1),
    "s": Decimal(1000),
    "m": Decimal(60_000),
    "h": Decimal(3_600_000),
}


def go_duration(text: str) -> float:
    """A duration as Go writes it, "30s", "1m30s", "1.5s" or "500ms", in
    seconds: REQUEST_TIMEOUT means the same in every implementation. It is
    read in whole milliseconds, as Go rounds it: "1.1s" is 1.1, not 1.1000000000000001."""
    if text == "0":
        return 0.0
    sign, body = (-1.0, text[1:]) if text.startswith("-") else (1.0, text.removeprefix("+"))
    parts = list(_DURATION.finditer(body))
    if not body or "".join(p[0] for p in parts) != body:
        raise ValueError(f"not a duration: {text!r}")
    milliseconds = int(sum((Decimal(p[1]) * _UNITS[p[2]] for p in parts), Decimal(0)).to_integral_value(ROUND_HALF_UP))
    return sign * milliseconds / 1000
