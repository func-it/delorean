"""JSON as the three quoters write it, byte for byte (docs/architecture.md,
"Identical quoters"): compact, keys in the order given, numbers as
ECMAScript's JSON.stringify writes them, times in UTC to the millisecond."""

import json
import math
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from enum import Enum


def dumps(value: object) -> str:
    return "".join(_parts(value))


def _parts(value: object) -> list[str]:
    match value:
        case None:
            return ["null"]
        case bool():
            return ["true" if value else "false"]
        case Enum():
            return _parts(value.value)
        case int():
            return [str(value)]
        case float():
            return [number(value)]
        case str():
            return [json.dumps(value, ensure_ascii=False)]
        case datetime():
            return [json.dumps(timestamp(value))]
        case Mapping():
            items = [f"{json.dumps(str(k), ensure_ascii=False)}:{''.join(_parts(v))}" for k, v in value.items()]
            return ["{", ",".join(items), "}"]
        case list() | tuple():
            return ["[", ",".join("".join(_parts(v)) for v in value), "]"]
    raise TypeError(f"{type(value).__name__} is not JSON")


def number(x: float) -> str:
    """x as ECMAScript's Number.prototype.toString writes it: 1, not 1.0;
    0.00001 and 1e-7, not 1e-05 and 1e-07."""
    if not math.isfinite(x):
        raise ValueError(f"{x} is not JSON")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    # the shortest digits that read back as x, as repr finds them
    _, digits_t, exponent = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(map(str, digits_t))
    k = len(digits)
    n = k + int(exponent)  # the value is 0.digits × 10^n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * -n + digits
    e = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"


def timestamp(t: datetime) -> str:
    """UTC, to the millisecond: 2026-10-03T13:10:22.946Z."""
    utc = t.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
