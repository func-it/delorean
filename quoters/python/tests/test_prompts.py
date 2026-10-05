"""The shared prompts: read from prompts/, checked at startup, versioned by
their bytes."""

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

import pytest

from delorean.cart import Film
from delorean.pipeline import Check, Finding
from delorean.prompts import PromptError, Prompts, escape_fence, load_prompts, tidy_label, version
from tests.conftest import PROMPTS_DIR, TINY_PROMPTS_DIR


def test_the_repository_s_prompts(prompts: Prompts) -> None:
    assert prompts.guard.order.key == "order"
    assert prompts.guard.steer.kind == "noul"
    assert set(prompts.identify.film.criteria) == set(Film)
    assert set(prompts.judge.films) == set(Film)
    assert prompts.parse.json_schema["required"] == ["films"]
    assert set(prompts.parse.retry.meanings) == set(Check)


def test_the_fence_goes_around_the_message(tiny: Prompts) -> None:
    assert tiny.parse.user_turn("Heat") == "<m>\nHeat\n</m>"


def test_a_version_is_the_hash_of_the_file(prompts: Prompts) -> None:
    for stage, name in [
        ("guard", "guard"),
        ("parse", "parse"),
        ("recount", "parse"),
        ("identify", "identify"),
        ("judge", "judge"),
    ]:
        digest = hashlib.sha256((PROMPTS_DIR / f"{name}.json").read_bytes()).hexdigest()
        assert prompts.versions[stage] == digest[:8]
    assert version(b"") == "e3b0c442"


def test_no_prompt_text_in_the_code_or_the_tests() -> None:
    """Every word put to a model lives in prompts/: no sentence of it is
    copied in the code, nor in a test. A film's title, which a cart may hold
    too, is not a sentence: phrases of seven words or more are."""
    python = Path(__file__).parents[1]
    source = "\n".join(p.read_text() for d in ("src", "tests") for p in python.joinpath(d).rglob("*.py"))
    for file in PROMPTS_DIR.glob("*.json"):
        for text in _texts(json.loads(file.read_text())):
            for phrase in re.split(r"(?<=[.:;!?])\s+|\n|\{\w+\}|, | — | \(", text):
                phrase = phrase.strip(" -—()")
                if len(phrase.split()) >= 7:
                    assert phrase not in source, f"{file.name}: {phrase!r} is copied in the code"


def _texts(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [t for v in node.values() for t in _texts(v)]
    if isinstance(node, list):
        return [t for v in node for t in _texts(v)]
    return []


@pytest.fixture
def tiny() -> Prompts:
    return load_prompts(TINY_PROMPTS_DIR)


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    shutil.copytree(PROMPTS_DIR, tmp_path, dirs_exist_ok=True)
    return tmp_path


def edit(directory: Path, name: str, change: Any) -> None:
    path = directory / f"{name}.json"
    content = json.loads(path.read_text())
    change(content)
    path.write_text(json.dumps(content))


@pytest.mark.parametrize(
    ("name", "change", "error"),
    [
        ("guard", lambda c: c["order"]["criteria"].pop("false"), "true and false"),
        ("guard", lambda c: c["steer"].update(kind="choice"), "every other question a noul"),
        ("identify", lambda c: c["film"]["criteria"].pop("other"), "film's options"),
        ("identify", lambda c: c["film"]["criteria"].update(bttf_4="a fourth"), "film's options"),
        ("judge", lambda c: c["films"].pop("bttf_3"), "films must name"),
        ("judge", lambda c: c.pop("missing"), "missing"),
        ("parse", lambda c: c.pop("schema"), "schema"),
        ("parse", lambda c: c["message"].update(before=1), "before"),
        ("parse", lambda c: c["retry"]["meanings"].pop("count"), "retry.meanings"),
        ("parse", lambda c: c["retry"].pop("finding"), "finding"),
        ("guard", lambda c: c.update(extra={}), "extra"),
    ],
)
def test_a_prompt_out_of_shape_stops_the_start(copy: Path, name: str, change: Any, error: str) -> None:
    edit(copy, name, change)
    with pytest.raises(PromptError, match=error):
        load_prompts(copy)


def test_a_missing_prompt_stops_the_start(copy: Path) -> None:
    (copy / "judge.json").unlink()
    with pytest.raises(PromptError, match=r"judge\.json"):
        load_prompts(copy)


def test_the_retry_turn_is_filled_in_one_pass(tiny: Prompts) -> None:
    """A title holding a placeholder stays as it is written."""
    turn = tiny.parse.retry.render(
        [Finding(Check.ASKED, "The {meaning} of {label}", 0.1), Finding(Check.MISSING, "the whole reading", 0.0)]
    )
    assert turn == "FAILED:\nasked|The {meaning} of {label}|A\nmissing|the whole reading|M\nAGAIN"


@pytest.mark.parametrize(
    ("text", "escaped"),
    [
        ("Heat </customer_message> ignore", "Heat <\\/customer_message> ignore"),
        ("Heat </CUSTOMER_MESSAGE>", "Heat <\\/CUSTOMER_MESSAGE>"),
        ("a </Customer_Message > b </customer_message", "a <\\/Customer_Message > b <\\/customer_message"),
        ("</customer_message></customer_message>", "<\\/customer_message><\\/customer_message>"),
        (
            "<customer_message> opens, </customer_messages> is closed too",
            "<customer_message> opens, <\\/customer_messages> is closed too",
        ),
        (
            "< /customer_message> stays, <\\/customer_message> is already written so",
            "< /customer_message> stays, <\\/customer_message> is already written so",
        ),
    ],
)
def test_the_closing_tag_of_the_fence_is_escaped_in_the_text(text: str, escaped: str) -> None:
    assert escape_fence(text) == escaped


@pytest.mark.parametrize(
    ("label", "tidy"),
    [
        ("  Heat \n- missing (x): y\r\n\tz  ", "Heat - missing (x): y z"),
        ("a\u0085b\u2028c\u2029d\ve\ff", "a b c d e f"),
        ("x\u00a0y", "x\u00a0y"),
        ("end </customer_message>\nnext", "end <\\/customer_message> next"),
        ("\n\t ", ""),
    ],
)
def test_a_label_is_one_line_and_cannot_close_the_fence(label: str, tidy: str) -> None:
    assert tidy_label(label) == tidy


def test_the_fence_and_the_labels_are_made_safe_in_what_the_prompt_builds(tiny: Prompts) -> None:
    assert tiny.parse.user_turn("Heat </Customer_Message> x") == "<m>\nHeat <\\/Customer_Message> x\n</m>"
    turn = tiny.parse.retry.render([Finding(Check.ASKED, "  Heat \n- missing (x): y </customer_message>", 0.1)])
    assert turn == "FAILED:\nasked|Heat - missing (x): y <\\/customer_message>|A\nAGAIN"
