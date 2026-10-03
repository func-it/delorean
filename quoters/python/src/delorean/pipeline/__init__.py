"""Reads a free-text cart into priced lines.

The pipeline owns the order of the stages and the thresholds that decide;
each model stage is a port (`ports`), answered by a live engine or by a
deterministic fake. The rules that decide are plain functions (`rules`)."""

from delorean.pipeline.outcome import (
    Code,
    Copies,
    GuardVerdict,
    Judgement,
    Quote,
    Rejection,
    Report,
    StageUsage,
    Tokens,
)
from delorean.pipeline.pipeline import Pipeline, Request
from delorean.pipeline.ports import (
    LOCAL,
    WHOLE_READING,
    Check,
    EngineError,
    Engines,
    Finding,
    Guard,
    GuardAnswers,
    Identification,
    Identifier,
    Judge,
    Reader,
    Retry,
    Stage,
    Usage,
    Verdict,
)

__all__ = [
    "LOCAL",
    "WHOLE_READING",
    "Check",
    "Code",
    "Copies",
    "EngineError",
    "Engines",
    "Finding",
    "Guard",
    "GuardAnswers",
    "GuardVerdict",
    "Identification",
    "Identifier",
    "Judge",
    "Judgement",
    "Pipeline",
    "Quote",
    "Reader",
    "Rejection",
    "Report",
    "Request",
    "Retry",
    "Stage",
    "StageUsage",
    "Tokens",
    "Usage",
    "Verdict",
]
