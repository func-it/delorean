"""What POST /v1/quotes reads: its headers and its body, strictly, every
failure in the contract's words rather than the decoder's."""

import json
import re
from typing import Final

from fastapi import Request

from delorean.api.contract import ProblemCode
from delorean.api.problems import ProblemError

USER_ID: Final = re.compile(r"[A-Za-z0-9._@-]{1,64}")
SESSION_ID: Final = re.compile(r"[A-Za-z0-9._:-]{1,128}")
REQUEST_ID: Final = re.compile(r"[A-Za-z0-9._:-]{1,128}")
"""The formats of the contract's headers, length included."""


def header(request: Request, name: str, form: re.Pattern[str]) -> str | None:
    """The value of an optional header, which has the contract's format."""
    values = request.headers.getlist(name)
    if not values:
        return None
    if len(values) > 1:
        raise _malformed(f"header {name}: expected one value, got {len(values)}")
    if not form.fullmatch(values[0]):
        raise _malformed(f"header {name}: must match ^{form.pattern}$")
    return values[0]


async def read_cart(request: Request, limit: int) -> str:
    """Decodes a QuoteRequest: one JSON object, with a cart string and no
    other field, in at most `limit` bytes. The checks come in the order every
    quoter makes them, in the same words (docs/architecture.md, "Identical
    quoters")."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise _too_large(limit)
    return _cart(bytes(body))


_JSON_BLANKS: Final = " \t\n\r"


def _cart(body: bytes) -> str:
    if not body.strip(_JSON_BLANKS.encode()):
        raise _malformed("body: empty, a QuoteRequest object is expected")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        raise _malformed("body: not valid UTF-8") from None
    decoder = json.JSONDecoder(parse_constant=_no_constant)
    start = len(text) - len(text.lstrip(_JSON_BLANKS))
    try:
        value, end = decoder.raw_decode(text, start)
    except json.JSONDecodeError as err:
        truncated = err.pos >= len(text.rstrip(_JSON_BLANKS)) or err.msg.startswith("Unterminated string")
        raise _malformed("body: truncated JSON" if truncated else "body: invalid JSON") from None
    except ValueError, RecursionError:
        raise _malformed("body: invalid JSON") from None
    if text[end:].strip(_JSON_BLANKS):
        raise _malformed("body: unexpected data after the QuoteRequest object")
    if not isinstance(value, dict):
        raise _malformed(f"body: a QuoteRequest object is expected, not a JSON {_kind(value)}")
    if unknown := next((k for k in value if k != "cart"), None):
        raise _malformed(f'body: unknown field "{unknown}"')
    if "cart" not in value:
        raise _malformed('body: field "cart" is required')
    cart = value["cart"]
    if not isinstance(cart, str):
        raise _malformed(f'body: field "cart" must be a string, not a JSON {_kind(cart)}')
    # JSON may escape a lone surrogate, which no UTF-8 text holds: the
    # replacement character stands for it, as Go's decoder puts it
    return _SURROGATE.sub("\ufffd", cart)


_SURROGATE: Final = re.compile("[\ud800-\udfff]")


def _no_constant(name: str) -> object:
    raise ValueError(f"{name} is not JSON")


def _kind(value: object) -> str:
    """The JSON type of a decoded value."""
    match value:
        case None:
            return "null"
        case bool():
            return "boolean"
        case int() | float():
            return "number"
        case str():
            return "string"
        case list():
            return "array"
    return "object"


def _malformed(detail: str) -> ProblemError:
    return ProblemError(400, ProblemCode.malformed_request, detail)


def _too_large(limit: int) -> ProblemError:
    return ProblemError(413, ProblemCode.payload_too_large, f"The body exceeds {limit} bytes.")
