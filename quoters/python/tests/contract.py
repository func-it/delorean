"""The contract, api/openapi.yaml, as JSON Schema: a body is held to the
contract's own schemas, not to this implementation's reading of them."""

from functools import cache
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.jsonschema import DRAFT202012

from tests.conftest import CONTRACT

_URI = "urn:delorean:openapi"


@cache
def document() -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load(CONTRACT.read_text())
    return loaded


def schema(name: str) -> dict[str, Any]:
    found: dict[str, Any] = document()["components"]["schemas"][name]
    return found


@cache
def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry().with_resource(_URI, DRAFT202012.create_resource(document()))
    return registry


def violations(name: str, body: object) -> list[str]:
    """How body breaks the contract's schema name; empty when it conforms."""
    validator = Draft202012Validator(
        {"$ref": f"{_URI}#/components/schemas/{name}"},
        registry=_registry(),
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    return [f"{'/'.join(map(str, e.absolute_path)) or '/'}: {e.message}" for e in validator.iter_errors(body)]
