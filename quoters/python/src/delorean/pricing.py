"""Prices identified lines in integer cents: what each film costs, and the
Back to the Future discount. It never sees the customer's text, and no model
ever computes a price."""

from collections.abc import Sequence
from dataclasses import dataclass

from delorean.cart import Film, Line


@dataclass(frozen=True, slots=True)
class Volume:
    """A Back to the Future film as the shop sells it."""

    film: Film
    title: str
    unit_cents: int


@dataclass(frozen=True, slots=True)
class Tier:
    """Takes `percent` off every saga DVD once a cart holds `distinct_volumes`
    different volumes."""

    distinct_volumes: int
    percent: int


@dataclass(frozen=True, slots=True)
class PricedLine:
    line: Line
    unit_cents: int
    subtotal_cents: int


@dataclass(frozen=True, slots=True)
class Discount:
    """The saga discount of a cart; `percent` is 0 when no tier is reached."""

    distinct_volumes: int = 0
    percent: int = 0
    base_cents: int = 0
    """The subtotal of the saga lines, on which `percent` applies."""
    amount_cents: int = 0


@dataclass(frozen=True, slots=True)
class Price:
    lines: tuple[PricedLine, ...]
    subtotal_cents: int
    discount: Discount
    total_cents: int


@dataclass(frozen=True, slots=True)
class Catalog:
    """What the shop sells and how it prices it."""

    volumes: tuple[Volume, ...]
    """The saga volumes, in order."""
    other_unit_cents: int
    """The price of any film outside the saga."""
    tiers: tuple[Tier, ...]
    """The saga discounts; the highest one reached applies."""

    def unit_cents(self, film: Film) -> int:
        """The price of one copy of film."""
        return next((v.unit_cents for v in self.volumes if v.film == film), self.other_unit_cents)

    def price(self, lines: Sequence[Line]) -> Price:
        """Each line at its unit price, then the highest tier the distinct saga
        volumes reach, taken off the saga lines only. Two lines of one volume
        count once among the distinct volumes, and both in the base."""
        priced = tuple(self._priced(line) for line in lines)
        subtotal = sum(p.subtotal_cents for p in priced)
        base = sum(p.subtotal_cents for p in priced if p.line.film.in_saga)
        distinct = len({line.film for line in lines if line.film.in_saga})
        reached = [t for t in self.tiers if distinct >= t.distinct_volumes]
        percent = max(reached, key=lambda t: t.distinct_volumes).percent if reached else 0
        # to the cent, half up; on this catalog the division is always exact
        amount = (base * percent + 50) // 100
        return Price(
            lines=priced,
            subtotal_cents=subtotal,
            discount=Discount(distinct_volumes=distinct, percent=percent, base_cents=base, amount_cents=amount),
            total_cents=subtotal - amount,
        )

    def _priced(self, line: Line) -> PricedLine:
        unit = self.unit_cents(line.film)
        return PricedLine(line=line, unit_cents=unit, subtotal_cents=unit * line.quantity)


DEFAULT_CATALOG = Catalog(
    volumes=(
        Volume(Film.BTTF_1, "Back to the Future", 1500),
        Volume(Film.BTTF_2, "Back to the Future Part II", 1500),
        Volume(Film.BTTF_3, "Back to the Future Part III", 1500),
    ),
    other_unit_cents=2000,
    tiers=(Tier(distinct_volumes=2, percent=10), Tier(distinct_volumes=3, percent=20)),
)
"""The shop's catalog: 15 EUR a volume, 20 EUR any other film, 10 % off the
saga with two distinct volumes, 20 % with three."""
