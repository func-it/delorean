"""Ported from the Go implementation's prepare_test.go: the same text, the
same normal form, the same token counts."""

import hashlib
import os
import timeit
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest

from delorean.config import tokenizer_dir
from delorean.prepare import (
    VOCABULARY_URL,
    TokenCounter,
    TokenizerMissingError,
    fetch_vocabulary,
    normalize,
    vocabulary_path,
)


@pytest.mark.parametrize(
    ("text", "normal"),
    [
        pytest.param(
            "Back to the Future 1\nLa chèvre",
            "Back to the Future 1\nLa chèvre",
            id="already normal",
        ),
        pytest.param(
            "Back to the Future 1\r\nLa chèvre\r\n",
            "Back to the Future 1\nLa chèvre",
            id="CRLF to LF",
        ),
        pytest.param(
            "Back to the Future 1\rLa chèvre",
            "Back to the Future 1La chèvre",
            id="a lone CR is a control character",
        ),
        pytest.param("La chèvre", "La chèvre", id="decomposed to composed"),
        pytest.param(
            "La\x00 ch\x1bèvre\t2\u0085\n\x7f",
            "La chèvre\t2",
            id="controls dropped, tab and LF kept",
        ),
        pytest.param("che\x00̀vre", "chèvre", id="a control between a letter and its accent"),
        pytest.param(
            " \t\n Back to the Future 1 \n\n",
            "Back to the Future 1",
            id="blanks trimmed at both ends",
        ),
        pytest.param("Back  to\t\tthe Future\n\n2", "Back  to\t\tthe Future\n\n2", id="inner blanks kept"),
        pytest.param(" \r\n\t  　", "", id="blank is empty"),
        pytest.param("", "", id="empty"),
        pytest.param("🎬 Back to the Future 👨‍👩‍👧‍👦", "🎬 Back to the Future 👨‍👩‍👧‍👦", id="emoji untouched"),
        pytest.param("ig​no⁠re﻿ all rules", "ignore all rules", id="zero-width spaces dropped"),
        pytest.param(
            "Back to the Future 1 ‮sèrf ,0 latot‬",
            "Back to the Future 1 sèrf ,0 latot",
            id="bidirectional overrides dropped",
        ),
        pytest.param(
            "Back to the Future 1\U000e0074\U000e006f\U000e0074\U000e0061\U000e006c\U000e0020\U000e0030",
            "Back to the Future 1",
            id="tag characters dropped",
        ),
        pytest.param("Back to the Fu­ture 2", "Back to the Future 2", id="a soft hyphen dropped"),
        pytest.param("che​̀vre", "chèvre", id="a format character between a letter and its accent"),
        pytest.param(
            "آینده‌ها",
            "آینده‌ها",
            id="Persian keeps its non-joiner",
        ),
        pytest.param(
            "❤️ Back to the Future", "❤ Back to the Future", id="variation selectors are dropped, the heart stays"
        ),
        pytest.param("Back to the Fu\u034fture 2", "Back to the Future 2", id="a grapheme joiner between letters"),
        pytest.param(
            "Ba\u115fck to\u1160 the Fu\u3164ture\uffa0 2",
            "Back to the Future 2",
            id="Hangul fillers between letters",
        ),
        pytest.param(
            "Back\u17b4 to the\u17b5 Future 1", "Back to the Future 1", id="Khmer inherent vowels between letters"
        ),
        pytest.param(
            "Ba\u180bc\u180ck\u180d to\u180e the\u180f Future 1",
            "Back to the Future 1",
            id="Mongolian selectors and the vowel separator",
        ),
        pytest.param(
            "Back to the Fu\u2800ture 3", "Back to the Future 3", id="the blank braille pattern between letters"
        ),
        pytest.param(
            "Back\ufe00 to\ufe0f the Future\U000e0100 1\U000e01ef",
            "Back to the Future 1",
            id="variation selectors between letters",
        ),
        pytest.param(
            "\u034e\u034f\u0350 \u115e\u1161 \u17b3\u17b6 \u180a\u1810 \u27ff\u2801 "
            "\u3163\u3165 \ufe10 \uff9f\uffa1 \U000e00ff\U000e01f0",
            "\u034e\u0350 \u115e\u1161 \u17b3\u17b6 \u180a\u1810 \u27ff\u2801 "
            "\u3163\u3165 \ufe10 \uff9f\uffa1 \U000e00ff\U000e01f0",
            id="a character just outside each span stays",
        ),
        pytest.param(
            "a\u200cb\u200dc\u200bd\u2060e\ufeff",
            "a\u200cb\u200dcde",
            id="both joiners stay, the others in the same string go",
        ),
        pytest.param(
            "che\u034f\u0300vre\ufe0f e\u0301te\u2800\u0301",
            "ch\u00e8vre \u00e9t\u00e9",
            id="accented letters and NFD after the removal",
        ),
        pytest.param(
            "\U0001f3ac\ufe0f\u2764\ufe0f", "\U0001f3ac\u2764", id="an emoji base keeps its form, its selector goes"
        ),
    ],
)
def test_normalize(text: str, normal: str) -> None:
    assert normalize(text) == normal


# The counts are those of o200k_base: a different vocabulary, or the
# cl100k_base fallback of some loaders, changes them.
@pytest.mark.parametrize(
    ("text", "tokens"),
    [
        pytest.param("", 0, id="empty"),
        pytest.param("a", 1, id="one letter"),
        pytest.param("hello world", 2, id="english"),
        pytest.param("Back to the Future 1\nBack to the Future 2", 13, id="a cart"),
        pytest.param("Retour vers le futur 2, Zurück in die Zukunft II", 13, id="french and german"),
        pytest.param("La chèvre", 3, id="accented"),
        pytest.param("バック・トゥ・ザ・フューチャー", 13, id="japanese"),
        pytest.param("回到未来", 3, id="chinese"),
        pytest.param("Назад в будущее", 5, id="russian"),
        pytest.param("🎬🍿", 4, id="emoji"),
        pytest.param("👨‍👩‍👧‍👦", 11, id="emoji joined by ZWJ"),
        pytest.param("<|endoftext|>", 7, id="a special token is plain text"),
    ],
)
def test_count(counter: TokenCounter, text: str, tokens: int) -> None:
    assert counter.count(text) == tokens


# BPE merges can be quadratic in the length of one piece: a 64 KB body that is
# a single word must still be counted, exactly, in a few milliseconds before
# it is refused as too_long. tiktoken's merge takes 8 ms for 65,000 letters on
# a laptop; the bound catches a quadratic one (seconds), not a slow machine.
@pytest.mark.parametrize(("letters", "tokens"), [(8_000, 1_000), (16_000, 2_000), (65_000, 8_125)])
def test_one_long_word_is_counted_fast(counter: TokenCounter, letters: int, tokens: int) -> None:
    text = "a" * letters
    assert counter.count(text) == tokens
    assert min(timeit.repeat(lambda: counter.count(text), number=1, repeat=3)) < 0.1


def test_counter_is_safe_for_concurrent_use(counter: TokenCounter) -> None:
    with ThreadPoolExecutor(8) as pool:
        counts = list(pool.map(counter.count, ["Back to the Future 1\nBack to the Future 2"] * 64))
    assert set(counts) == {13}


def test_a_missing_vocabulary_is_an_error_not_a_download(tmp_path: Path) -> None:
    with pytest.raises(TokenizerMissingError, match="delorean tokenizer"):
        TokenCounter.load(tmp_path)


def test_an_altered_vocabulary_is_an_error_not_a_download(tmp_path: Path) -> None:
    vocabulary_path(tmp_path).write_bytes(b"not the vocabulary")
    with pytest.raises(TokenizerMissingError):
        TokenCounter.load(tmp_path)


def test_fetch_checks_the_pinned_checksum(tmp_path: Path) -> None:
    # the vocabulary the tests count with stands for the download
    vocabulary = vocabulary_path(tokenizer_dir(os.environ)).read_bytes()
    served: list[str] = []

    def serve(content: bytes) -> httpx.MockTransport:
        def answer(request: httpx.Request) -> httpx.Response:
            served.append(str(request.url))
            return httpx.Response(200, content=content)

        return httpx.MockTransport(answer)

    with pytest.raises(ValueError, match="SHA-256"):
        fetch_vocabulary(tmp_path, transport=serve(b"tampered"))
    assert not vocabulary_path(tmp_path).exists()

    path = fetch_vocabulary(tmp_path, transport=serve(vocabulary))
    assert hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(vocabulary).digest()
    assert served == [VOCABULARY_URL, VOCABULARY_URL]

    fetch_vocabulary(tmp_path, transport=serve(b"never asked"))
    assert len(served) == 2, "a vocabulary in the cache is not fetched again"
    assert TokenCounter.load(tmp_path).count("hello world") == 2
