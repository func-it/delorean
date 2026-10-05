"""Readies a cart's text before any model reads it: one normal form, and its
size in tokens."""

import hashlib
import os
import unicodedata
from pathlib import Path
from typing import Final

import httpx
import tiktoken

_KEPT: Final = frozenset(
    {
        "\n",
        "\t",
        "‌",  # zero-width non-joiner, part of how Persian is spelt
        "‍",  # zero-width joiner, which builds 👨‍👩‍👧 and some scripts' letters
    }
)


_INVISIBLE: Final = (
    (0x034F, 0x034F),  # combining grapheme joiner
    (0x115F, 0x1160),  # Hangul choseong and jungseong fillers
    (0x17B4, 0x17B5),  # Khmer inherent vowels
    (0x180B, 0x180F),  # Mongolian free variation selectors, and the vowel separator
    (0x2800, 0x2800),  # blank braille pattern
    (0x3164, 0x3164),  # Hangul filler
    (0xFE00, 0xFE0F),  # variation selectors
    (0xFFA0, 0xFFA0),  # halfwidth Hangul filler
    (0xE0100, 0xE01EF),  # variation selectors supplement
)
"""The characters that draw nothing and are not format characters, so that
they can hide text from a reader as the zero-width ones do. An explicit table,
the same in the three quoters: the runtimes' Unicode versions differ, and a
property would too."""


def _is_invisible(char: str) -> bool:
    code = ord(char)
    return any(low <= code <= high for low, high in _INVISIBLE)


def normalize(text: str) -> str:
    """Puts text in one form: LF line ends, nothing invisible but \\n, \\t and
    the joiners, Unicode NFC, no blanks at either end. Two carts that look
    alike reach the models alike.

    What goes is what a reader cannot see but a model reads: control
    characters, and the format characters (Unicode Cf) but the joiners —
    zero-width spaces, which split a word to slip it past a reader;
    bidirectional overrides, which show text in another order than it is
    read; tag characters, which spell ASCII no one sees. An instruction hidden
    there would reach the models and no reviewer. And the characters of
    `_INVISIBLE`.
    """
    text = text.replace("\r\n", "\n")
    text = "".join(c for c in text if c in _KEPT or not (unicodedata.category(c) in {"Cc", "Cf"} or _is_invisible(c)))
    # NFC once they are gone: one between a letter and its accent would
    # otherwise keep them apart
    return unicodedata.normalize("NFC", text).strip()


ENCODING: Final = "o200k_base"
"""The BPE vocabulary tokens are counted with. Jev's tokenizer is not
published; o200k_base, that of OpenAI's current models, is an estimate, and
the margin between the cart limit and Jev's 32k tokens per question covers
its error."""

VOCABULARY_URL: Final = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
VOCABULARY_SHA256: Final = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
# tiktoken looks a vocabulary up in TIKTOKEN_CACHE_DIR under the SHA-1 of its
# URL, and downloads it on a miss or a wrong checksum
_CACHE_KEY: Final = hashlib.sha1(VOCABULARY_URL.encode(), usedforsecurity=False).hexdigest()


class TokenizerMissingError(RuntimeError):
    """The vocabulary is not in the cache: counting would download it."""


def vocabulary_path(cache_dir: Path) -> Path:
    return cache_dir / _CACHE_KEY


def fetch_vocabulary(cache_dir: Path, transport: httpx.BaseTransport | None = None) -> Path:
    """Downloads the vocabulary into cache_dir, once, checked against its
    pinned SHA-256: the only time delorean fetches it (`delorean tokenizer`,
    and the Docker build)."""
    path = vocabulary_path(cache_dir)
    if _verified(path):
        return path
    with httpx.Client(timeout=60, follow_redirects=True, transport=transport) as http:
        response = http.get(VOCABULARY_URL)
    response.raise_for_status()
    if hashlib.sha256(response.content).hexdigest() != VOCABULARY_SHA256:
        raise ValueError(f"{VOCABULARY_URL}: the download does not match its pinned SHA-256")
    cache_dir.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    partial.write_bytes(response.content)
    partial.replace(path)
    return path


def ranks(path: Path) -> int:
    """The number of merge ranks of a vocabulary file: one per line."""
    return sum(1 for line in path.read_bytes().splitlines() if line.strip())


def _verified(path: Path) -> bool:
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == VOCABULARY_SHA256


class TokenCounter:
    """Counts tokens, without network. Loading takes a few hundred
    milliseconds: build one and share it, it is safe for concurrent use."""

    def __init__(self, encoding: tiktoken.Encoding) -> None:
        self._encoding = encoding

    @classmethod
    def load(cls, cache_dir: Path) -> TokenCounter:
        """The counter of o200k_base, read from cache_dir. A vocabulary that is
        missing or altered is an error at once, never a download."""
        if not _verified(vocabulary_path(cache_dir)):
            raise TokenizerMissingError(
                f"the {ENCODING} vocabulary is not in {cache_dir}: "
                "fetch it once with `delorean tokenizer` (task py:tokenizer)"
            )
        # the only way to point tiktoken at its cache; checked above, so it
        # reads the file and fetches nothing
        os.environ["TIKTOKEN_CACHE_DIR"] = str(cache_dir)
        return cls(tiktoken.get_encoding(ENCODING))

    def count(self, text: str) -> int:
        """The number of tokens of text. A special token such as
        <|endoftext|> counts as the plain text it is in a customer's cart."""
        return len(self._encoding.encode_ordinary(text))
