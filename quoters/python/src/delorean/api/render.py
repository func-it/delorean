"""A contract body as the three quoters write it, byte for byte."""

from pydantic import BaseModel

from delorean.jsontext import dumps


def body(model: BaseModel) -> bytes:
    """A contract body: its fields in declaration order, absent ones left out."""
    return dumps(model.model_dump(exclude_none=True)).encode()
