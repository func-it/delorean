"""The key of a title, the same in the three quoters to the code point: the table
below is in the Go and TypeScript tests too."""

import pytest

from delorean.cart import title_key, trim_space
from delorean.pipeline import Pipeline, Rejection, Request


@pytest.mark.parametrize(
    ("title", "key"),
    [
        ("  Back   TO\tthe Future  ", "back to the future"),
        ("İSTANBUL", "istanbul"),
        ("ΟΔΟΣ", "οδοσ"),
        ("ΑΣ Σ", "ασ σ"),
        ("Ὀδυσσεύς ΟΔΥΣΣΕΎΣ", "ὀδυσσεύς οδυσσεύσ"),
        ("ẞ", "ß"),
        ("K", "k"),
        ("ǅ ǈ", "ǆ ǉ"),
        ("ᾈ", "ᾀ"),
        ("Ⅷ", "ⅷ"),
        ("I", "i"),
        ("日本語 ＡＢＣ", "日本語 ａｂｃ"),
    ],
)
def test_the_key_of_a_title_is_held_to_the_table_the_three_quoters_share(title: str, key: str) -> None:
    assert title_key(title) == key


@pytest.mark.parametrize(
    ("title", "key"),
    [
        ("a\u0085b", "a b"),
        ("a b", "a b"),
        ("a b", "a b"),
        ("a　b", "a b"),
        ("a﻿b", "a﻿b"),
        ("a\u001fb", "a\u001fb"),
        ("\u0085a ", "a"),
    ],
)
def test_a_blank_is_what_gos_unicode_is_space_says(title: str, key: str) -> None:
    """U+0085 and U+00A0 are blanks; U+FEFF and U+001F are not, whatever Python's split or JavaScript's \\s say."""
    assert title_key(title) == key


def test_the_same_blanks_are_trimmed() -> None:
    assert trim_space("\u0085  Heat 　") == "Heat"
    assert trim_space("﻿Heat\u001f") == "﻿Heat\u001f"


async def test_a_refusal_quotes_a_title_as_json_does(pipeline: Pipeline) -> None:
    """The detail quotes the title as JSON.stringify does: the quote, the backslash and the control
    characters escaped, the rest as is, U+2028 and non-ASCII included."""
    outcome = await pipeline.quote(Request(cart='1001 x Bac k "to" é\tFuture end'))
    assert isinstance(outcome, Rejection)
    assert outcome.detail == (
        '"Bac k \\"to\\" é\\tFuture end" is asked in 1001 copies; a cart holds at most 1000 of a title.'
    )
