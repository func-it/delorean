"""Logs as the three quoters write them (docs/architecture.md, "Identical
quoters"): one compact JSON object per line on stdout, keys time, level, msg,
then the event's own; time in UTC to the millisecond. A library's lines are
silenced: the server's, the SDKs'."""

import logging
import sys
from datetime import UTC, datetime
from typing import Final, override

from delorean.jsontext import dumps, timestamp

# color_message is uvicorn's message again, with terminal colours
_RECORD_FIELDS: Final = frozenset(vars(logging.makeLogRecord({}))) | {"message", "asctime", "color_message"}
_LEVELS: Final = {"WARNING": "WARN", "CRITICAL": "ERROR"}
_SILENCED: Final = ("langfuse", "opentelemetry", "httpx", "openai")
"""The libraries whose own lines are not the quoters': their failures reach
the log through delorean's own lines."""


class JsonFormatter(logging.Formatter):
    """A record as one JSON line; the `extra` of a log call become fields."""

    @override
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": timestamp(datetime.fromtimestamp(record.created, UTC)),
            "level": _LEVELS.get(record.levelname, record.levelname),
            "msg": record.getMessage(),
        }
        entry.update((k, v) for k, v in vars(record).items() if k not in _RECORD_FIELDS)
        if record.exc_info:
            entry["trace"] = self.formatException(record.exc_info)
        return dumps(entry)


def configure(level: int = logging.INFO) -> None:
    """Every logger of the process as JSON on stdout; uvicorn's errors only,
    the SDKs' none."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=level, handlers=[handler], force=True)
    logging.getLogger("uvicorn").setLevel(logging.ERROR)
    for name in _SILENCED:
        logging.getLogger(name).setLevel(logging.CRITICAL + 1)
