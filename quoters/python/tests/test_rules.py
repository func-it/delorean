"""The rules that decide, one by one."""

import math
from typing import cast

import pytest

from delorean.cart import MAX_COPIES, MAX_QUANTITY, Film, Line, Mention
from delorean.pipeline import (
    Check,
    Copies,
    EngineError,
    Finding,
    GuardAnswers,
    Identification,
    Verdict,
    rules,
)


@pytest.mark.parametrize(
    ("order", "steer", "verdict", "confidence"),
    [
        pytest.param(1.0, 0.01, Verdict.VALID, 0.99, id="an order"),
        pytest.param(0.0, 0.01, Verdict.INVALID, 0.99, id="no order"),
        pytest.param(1.0, 0.99, Verdict.INJECTION, 0.99, id="an order that steers"),
        pytest.param(0.9, 0.5, Verdict.INJECTION, 0.5, id="a tie goes to the refusal"),
        pytest.param(0.5, 0.0, Verdict.INVALID, 0.5, id="a tie of valid and invalid is invalid"),
        pytest.param(0.8, 0.3, Verdict.VALID, 0.7 * 0.8, id="the likeliest"),
    ],
)
def test_guard_verdict(order: float, steer: float, verdict: Verdict, confidence: float) -> None:
    v = rules.guard_verdict(GuardAnswers(order=order, steer=steer))
    assert v.verdict == verdict
    assert v.confidence == pytest.approx(confidence)
    assert v.probabilities == {
        Verdict.INJECTION: steer,
        Verdict.VALID: pytest.approx((1 - steer) * order),
        Verdict.INVALID: pytest.approx((1 - steer) * (1 - order)),
    }
    assert sum(v.probabilities.values()) == pytest.approx(1)


def test_the_fake_guard_answers_make_exactly_099() -> None:
    # the e2e suite compares confidences with ==
    for order, steer in [(1.0, 0.01), (0.0, 0.01), (1.0, 0.99), (0.0, 0.99)]:
        assert rules.guard_verdict(GuardAnswers(order=order, steer=steer)).confidence == 0.99


@pytest.mark.parametrize(("order", "steer"), [(1.2, 0.0), (0.5, -0.1), (math.nan, 0.0), (0.5, math.nan)])
def test_guard_answers_out_of_contract(order: float, steer: float) -> None:
    with pytest.raises(EngineError):
        rules.guard_verdict(GuardAnswers(order=order, steer=steer))


def test_merge() -> None:
    merged = rules.merge(
        [
            Mention(" Back to the Future Part II ", 1),
            Mention("Heat", 2),
            Mention("back to the  future\tpart ii", 3),
        ]
    )
    assert merged == [Mention("Back to the Future Part II", 4), Mention("Heat", 2)]


@pytest.mark.parametrize("mention", [Mention("", 1), Mention(" ", 1), Mention("Heat", 0), Mention("Heat", -1)])
def test_merge_refuses_what_a_reader_may_not_say(mention: Mention) -> None:
    with pytest.raises(EngineError):
        rules.merge([mention])


def test_merge_saturates_as_go_does() -> None:
    assert rules.merge([Mention("Heat", 2), Mention("Heat", MAX_COPIES)]) == [Mention("Heat", MAX_COPIES)]


def test_too_many_copies() -> None:
    heat = Mention("Heat", MAX_QUANTITY)
    assert rules.too_many_copies([heat, Mention("La chèvre", 1)]) is None
    assert rules.too_many_copies([Mention("La chèvre", 1), Mention("Heat", 1001)]) == Copies("Heat", 1001, 1000)


def test_distinct_titles_of_both_readings() -> None:
    parsed = [Mention("Heat", 1), Mention("La chèvre", 1)]
    recounted = [Mention("heat", 2), Mention("Le Grand Bleu", 1), Mention("LA  CHÈVRE", 1)]
    assert rules.distinct_titles(parsed, recounted) == ["Heat", "La chèvre", "Le Grand Bleu"]


def test_identified() -> None:
    ids = [Identification(Film.BTTF_2, 0.9), Identification(Film.OTHER, 1.0)]
    by_key = rules.identified(["BTTF 2", "Heat"], ids)
    assert rules.lines([Mention("BTTF 2", 2), Mention("heat", 1)], by_key) == [
        Line("BTTF 2", 2, Film.BTTF_2, 0.9),
        Line("heat", 1, Film.OTHER, 1.0),
    ]


@pytest.mark.parametrize(
    "ids",
    [
        pytest.param([Identification(Film.BTTF_2, 1.0)], id="one missing"),
        pytest.param(
            [Identification(cast(Film, "bttf_4"), 1.0), Identification(Film.OTHER, 1.0)],
            id="a film out of Film",
        ),
        pytest.param(
            [Identification(Film.BTTF_2, 1.2), Identification(Film.OTHER, 1.0)],
            id="a confidence over 1",
        ),
        pytest.param(
            [Identification(Film.BTTF_2, math.nan), Identification(Film.OTHER, 1.0)],
            id="no confidence",
        ),
    ],
)
def test_identified_refuses_answers_out_of_contract(ids: list[Identification]) -> None:
    with pytest.raises(EngineError):
        rules.identified(["BTTF 2", "Heat"], ids)


def lines_of(**copies: int) -> list[Line]:
    return [Line(f"title of {film}", n, Film(film), 1.0) for film, n in copies.items()]


def test_count_findings_agree() -> None:
    reading = [*lines_of(bttf_1=1, other=2), Line("Heat", 1, Film.OTHER, 1.0)]
    recount = lines_of(other=3, bttf_1=1)
    assert rules.count_findings(reading, recount) == [
        Finding(Check.COUNT, "bttf_1: 1 read, 1 recounted", 1.0),
        Finding(Check.COUNT, "other: 3 read, 3 recounted", 1.0),
    ]


def test_count_findings_disagree_on_any_film_either_reading_has() -> None:
    assert rules.count_findings(lines_of(bttf_2=1), lines_of(bttf_2=2, bttf_3=1)) == [
        Finding(Check.COUNT, "bttf_2: 1 read, 2 recounted", 0.0),
        Finding(Check.COUNT, "bttf_3: 0 read, 1 recounted", 0.0),
    ]


def test_judged_holds_the_judge_to_its_contract() -> None:
    reading = lines_of(bttf_1=1)
    asked, identity = Finding(Check.ASKED, "x", 1.0), Finding(Check.IDENTITY, "x", 0.8)
    missing = Finding(Check.MISSING, "the whole reading", 0.9)
    assert rules.judged([asked, identity, missing], reading) == [asked, identity, missing]
    for findings in (
        [asked, missing],
        [identity, asked, missing],
        [asked, identity],
        [asked, identity, missing, missing],
        [asked, identity, Finding(Check.MISSING, "the whole reading", math.nan)],
        [asked, identity, Finding(Check.COUNT, "bttf_1", 1.0)],
    ):
        with pytest.raises(EngineError):
            rules.judged(findings, reading)


def test_the_worst_score_decides() -> None:
    findings = [
        Finding(Check.ASKED, "a", 0.9),
        Finding(Check.MISSING, "m", 0.4),
        Finding(Check.COUNT, "c", 1.0),
    ]
    assert rules.judgement(findings).score == 0.4


def test_nothing_read_misses_everything() -> None:
    assert rules.NOTHING_READ.score == 0
    assert rules.NOTHING_READ.findings == (Finding(Check.MISSING, "the whole reading", 0.0),)


def test_the_same_lines_in_any_order_are_the_same_reading() -> None:
    heat, ronin = Line("Heat", 1, Film.OTHER, 1.0), Line("Ronin", 2, Film.OTHER, 0.9)
    assert rules.facts([heat, ronin]) == rules.facts([ronin, heat])
    assert rules.facts([heat]) != rules.facts([Line("Heat", 2, Film.OTHER, 1.0)])
    assert rules.facts([heat]) != rules.facts([Line("Heat", 1, Film.BTTF_1, 1.0)])
    assert rules.facts([heat]) == rules.facts([Line("Heat", 1, Film.OTHER, 0.5)]), "confidence aside"


def test_judged_findings_follow_the_reading_s_order() -> None:
    heat, ronin = Line("Heat", 1, Film.OTHER, 1.0), Line("Ronin", 2, Film.OTHER, 1.0)
    findings = [
        Finding(Check.ASKED, "Heat", 0.9),
        Finding(Check.IDENTITY, "Heat", 0.8),
        Finding(Check.ASKED, "Ronin", 0.7),
        Finding(Check.IDENTITY, "Ronin", 0.6),
        Finding(Check.MISSING, "the whole reading", 0.5),
    ]
    judged = rules.Judged.of(findings, [heat, ronin])
    assert judged.findings([heat, ronin]) == findings
    assert judged.findings([ronin, heat]) == [*findings[2:4], *findings[0:2], findings[4]]
