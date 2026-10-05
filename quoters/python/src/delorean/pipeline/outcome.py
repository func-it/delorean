"""What a reading comes to: a quote, or a rejection that says which stage
refused the cart and why, both with what the reading took."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum

from delorean.pipeline.ports import Finding, GuardAnswers, Stage, Verdict
from delorean.pricing import Price


@dataclass(frozen=True, slots=True)
class GuardVerdict:
    """The guard's reading of a request: the likeliest verdict, its
    probability, and what it is made of."""

    verdict: Verdict
    confidence: float
    probabilities: Mapping[Verdict, float]
    answers: GuardAnswers


@dataclass(frozen=True, slots=True)
class Judgement:
    """The judge's view of a reading: every finding, and the worst score,
    which decides."""

    score: float
    findings: Sequence[Finding]
    attempts: int = 1
    """How many readings were made before this outcome."""


@dataclass(frozen=True, slots=True)
class StageUsage:
    """What one stage took."""

    stage: Stage
    engine: str
    model: str | None
    calls: int
    ms: int
    cost_usd: float
    tokens: int | None = None
    """The input tokens, which only prepare counts."""
    degraded: bool = False
    """The stage failed and the quote went on without it. Only the recount
    can: it is a second opinion, and the judge is still the guard."""

    def __add__(self, later: StageUsage) -> StageUsage:
        """The stage over two attempts: calls, time and cost add up; degraded
        once, degraded."""
        return replace(
            self,
            calls=self.calls + later.calls,
            ms=self.ms + later.ms,
            cost_usd=self.cost_usd + later.cost_usd,
            degraded=self.degraded or later.degraded,
        )


@dataclass(slots=True)
class Report:
    """What a reading took: each stage that ran, in pipeline order, its
    attempts added up, and the totals. `trace_id` is set only when traces are exported. The pipeline
    fills it as the reading goes."""

    ms: int = 0
    trace_id: str | None = None
    _stages: dict[Stage, StageUsage] = field(default_factory=dict)

    @property
    def stages(self) -> list[StageUsage]:
        # parse and recount run side by side and end in any order
        return sorted(self._stages.values(), key=lambda u: list(Stage).index(u.stage))

    @property
    def cost_usd(self) -> float:
        return sum(u.cost_usd for u in self.stages)

    def record(self, usage: StageUsage) -> None:
        """Adds what a stage took; a stage run again, on a later attempt, adds
        up with its earlier runs."""
        earlier = self._stages.get(usage.stage)
        self._stages[usage.stage] = usage if earlier is None else earlier + usage


class Code(StrEnum):
    """Which stage refused a cart, and why: the API's problem codes."""

    EMPTY_CART = "empty_cart"  # prepare
    TOO_LONG = "too_long"  # prepare
    INJECTION = "injection"  # guard
    INVALID_REQUEST = "invalid_request"  # guard
    NO_FILM = "no_film"  # parse
    QUANTITY_TOO_LARGE = "quantity_too_large"  # parse
    UNFAITHFUL_READING = "unfaithful_reading"  # judge
    QUANTITY_UNVERIFIED = "quantity_unverified"  # price: no recount to count against; retryable


@dataclass(frozen=True, slots=True)
class Tokens:
    """The size of a cart against its limit."""

    count: int
    max: int


@dataclass(frozen=True, slots=True)
class Copies:
    """How many copies of a title a cart asks, against the limit."""

    title: str
    count: int
    max: int


@dataclass(frozen=True, slots=True)
class Rejection:
    """A cart a stage refused to price: the facts that decided, and what the
    reading took up to there."""

    code: Code
    detail: str
    """Why, in a sentence for the customer."""
    report: Report
    tokens: Tokens | None = None
    """Set by too_long."""
    guard: GuardVerdict | None = None
    """Set by injection and invalid_request."""
    copies: Copies | None = None
    """Set by quantity_too_large."""
    judgement: Judgement | None = None
    """Set by unfaithful_reading."""


@dataclass(frozen=True, slots=True)
class Quote:
    """A cart read, held faithful by the judge, and priced."""

    id: str
    price: Price
    judgement: Judgement
    report: Report
    created_at: datetime
