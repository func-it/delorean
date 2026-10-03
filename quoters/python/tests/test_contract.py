"""The contract's bodies are generated from api/openapi.yaml (task generate):
the generated module is the contract's, and the domain's enums are its
enums."""

import subprocess
import sys
import tempfile
from enum import Enum
from pathlib import Path

import pytest

from delorean.api import contract
from delorean.api.contract import ProblemCode
from delorean.cart import Film
from delorean.pipeline import Check, Code, Stage, Verdict

PROJECT = Path(__file__).parents[1]


def test_the_generated_models_are_the_contract_s() -> None:
    """api/contract.py is what task generate makes of api/openapi.yaml today.
    Generated inside the project, so that ruff formats it with its settings."""
    with tempfile.TemporaryDirectory(dir=PROJECT) as directory:
        generated = Path(directory) / "contract.py"
        subprocess.run(  # noqa: S603 — the generator, on the repository's contract
            [sys.executable, "-m", "datamodel_code_generator", "--output", str(generated)],
            cwd=PROJECT,
            check=True,
            capture_output=True,
        )
        assert generated.read_text() == (PROJECT / "src/delorean/api/contract.py").read_text(), "run task generate"


@pytest.mark.parametrize(
    ("domain", "contracted"),
    [(Film, contract.Film), (Stage, contract.Stage), (Check, contract.Check), (Verdict, contract.Verdict)],
    ids=lambda e: e.__name__,
)
def test_the_domain_s_enums_are_the_contract_s(domain: type[Enum], contracted: type[Enum]) -> None:
    assert [e.value for e in domain] == [e.value for e in contracted]


def test_every_refusal_has_its_problem_code() -> None:
    assert {c.value for c in Code} <= {c.value for c in ProblemCode}
