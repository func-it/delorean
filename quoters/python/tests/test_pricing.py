"""Ported from the Go implementation's pricing_test.go."""

from dataclasses import replace

import pytest

from delorean.cart import MAX_QUANTITY, Film, Line
from delorean.pricing import DEFAULT_CATALOG, Discount


def line(title: str, quantity: int, film: Film) -> Line:
    return Line(title=title, quantity=quantity, film=film, confidence=1.0)


BTTF1 = line("Back to the Future 1", 1, Film.BTTF_1)
BTTF2 = line("Back to the Future 2", 1, Film.BTTF_2)
BTTF3 = line("Back to the Future 3", 1, Film.BTTF_3)
CHEVRE = line("La chèvre", 1, Film.OTHER)


@pytest.mark.parametrize(
    ("lines", "subtotal", "discount", "total"),
    [
        pytest.param(
            [BTTF1, BTTF2, BTTF3],
            4500,
            Discount(3, 20, 4500, 900),
            3600,
            id="brief 1: three volumes, 20 %",
        ),
        pytest.param([BTTF1, BTTF3], 3000, Discount(2, 10, 3000, 300), 2700, id="brief 2: two volumes, 10 %"),
        pytest.param([BTTF1], 1500, Discount(1, 0, 1500, 0), 1500, id="brief 3: one volume, no discount"),
        pytest.param(
            [BTTF1, BTTF2, BTTF3, BTTF2],
            6000,
            Discount(3, 20, 6000, 1200),
            4800,
            id="brief 4: a second copy is in the base, not among the distinct volumes",
        ),
        pytest.param(
            [BTTF1, BTTF2, BTTF3, CHEVRE],
            6500,
            Discount(3, 20, 4500, 900),
            5600,
            id="brief 5: another film is full price, out of the base",
        ),
        pytest.param(
            [line("BTTF 2", 1, Film.BTTF_2), line("Retour vers le futur 2", 1, Film.BTTF_2)],
            3000,
            Discount(1, 0, 3000, 0),
            3000,
            id="two titles of one volume count once",
        ),
        pytest.param(
            [line("BTTF 2", 1, Film.BTTF_2), line("Retour vers le futur 2", 1, Film.BTTF_2), BTTF1],
            4500,
            Discount(2, 10, 4500, 450),
            4050,
            id="two titles of one volume and another volume reach 10 %",
        ),
        pytest.param(
            [CHEVRE, line("Le Grand Bleu", 3, Film.OTHER)],
            8000,
            Discount(),
            8000,
            id="other films only",
        ),
        pytest.param(
            [line("Back to the Future", 100, Film.BTTF_1), BTTF2, line("Heat", 2, Film.OTHER)],
            155500,
            Discount(2, 10, 151500, 15150),
            140350,
            id="many copies",
        ),
        pytest.param(
            [
                line("1", MAX_QUANTITY, Film.BTTF_1),
                line("2", MAX_QUANTITY, Film.BTTF_2),
                line("3", MAX_QUANTITY, Film.BTTF_3),
            ],
            4_500_000,
            Discount(3, 20, 4_500_000, 900_000),
            3_600_000,
            id="the most a cart may hold of each volume",
        ),
        pytest.param([], 0, Discount(), 0, id="no lines"),
    ],
)
def test_price(lines: list[Line], subtotal: int, discount: Discount, total: int) -> None:
    price = DEFAULT_CATALOG.price(lines)
    assert price.subtotal_cents == subtotal
    assert price.discount == discount
    assert price.total_cents == total
    assert [p.line for p in price.lines] == lines
    for p in price.lines:
        assert p.subtotal_cents == p.unit_cents * p.line.quantity
    assert sum(p.subtotal_cents for p in price.lines) == price.subtotal_cents


def test_unit_cents() -> None:
    assert {f: DEFAULT_CATALOG.unit_cents(f) for f in Film} == {
        Film.BTTF_1: 1500,
        Film.BTTF_2: 1500,
        Film.BTTF_3: 1500,
        Film.OTHER: 2000,
    }


# The default catalog always divides exactly; a catalog with odd prices shows
# the rounding, half up.
@pytest.mark.parametrize(
    ("lines", "amount"),
    [
        pytest.param([line("1", 1, Film.BTTF_1), line("3", 1, Film.BTTF_3)], 301, id="half rounds up"),  # 10 % of 3005
        pytest.param([line("2", 1, Film.BTTF_2), line("3", 1, Film.BTTF_3)], 300, id="below half rounds down"),  # 3004
    ],
)
def test_price_rounds_half_up(lines: list[Line], amount: int) -> None:
    volumes = DEFAULT_CATALOG.volumes
    odd = replace(
        DEFAULT_CATALOG,
        volumes=(
            replace(volumes[0], unit_cents=1505),
            replace(volumes[1], unit_cents=1504),
            volumes[2],
        ),
    )
    assert odd.price(lines).discount.amount_cents == amount


def test_the_highest_tier_reached_applies() -> None:
    assert DEFAULT_CATALOG.price([BTTF1, BTTF2, BTTF3]).discount.percent == 20
