"""The vocabulary of a reading: the films the shop prices, and the lines a
customer's text is read into. Values only, with what they can tell about
themselves."""

from dataclasses import dataclass
from enum import StrEnum


class Film(StrEnum):
    """What a title is identified as: the answers the identification may give,
    and the ids of the API contract. Saga volumes first, in order."""

    BTTF_1 = "bttf_1"
    BTTF_2 = "bttf_2"
    BTTF_3 = "bttf_3"
    OTHER = "other"

    @property
    def volume(self) -> int:
        """The saga volume, 1 to 3, and 0 for any other film."""
        match self:
            case Film.BTTF_1:
                return 1
            case Film.BTTF_2:
                return 2
            case Film.BTTF_3:
                return 3
            case Film.OTHER:
                return 0

    @property
    def in_saga(self) -> bool:
        return self.volume > 0


MAX_QUANTITY = 1000
"""The most copies of one title a cart may ask, its mentions merged; above,
the cart is refused. No DVD shop would serve more, and every amount in cents
stays far from overflow."""


MAX_COPIES = 2**63 - 1
"""The most copies any count holds: Go's int, which every implementation
keeps to. A quantity or a sum past it saturates there."""


@dataclass(frozen=True, slots=True)
class Mention:
    """A film the customer asks to buy, as a reader reads it: the title as
    written, and how many copies."""

    title: str
    quantity: int
    film: Film | None = None
    """Set when the parse identified the title too (PARSE_IDENTIFIES): the
    title is then not put to the identifier."""


@dataclass(frozen=True, slots=True)
class Line:
    """A mention once its title is identified."""

    title: str
    quantity: int
    film: Film
    confidence: float
    """Calibrated confidence of the identification, 0 to 1."""


def title_key(title: str) -> str:
    """What makes two titles one: case and spacing aside, "Heat" and " heat"
    are the same title. Two spellings of one volume are not."""
    return " ".join(title.split()).lower()
