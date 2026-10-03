"""The pipeline's outcomes, as the contract's bodies (api/contract.py,
generated from api/openapi.yaml)."""

from typing import Literal

from delorean import pipeline
from delorean.api import contract
from delorean.api.problems import problem


def quote(q: pipeline.Quote, *, engines: Literal["live", "fake"], threshold: float) -> contract.Quote:
    price = q.price
    return contract.Quote(
        id=q.id,
        currency="EUR",
        lines=[
            contract.QuoteLine(
                title=p.line.title,
                quantity=p.line.quantity,
                film=contract.Film(p.line.film),
                confidence=p.line.confidence,
                unit_price_cents=p.unit_cents,
                subtotal_cents=p.subtotal_cents,
            )
            for p in price.lines
        ],
        subtotal_cents=price.subtotal_cents,
        discount=contract.Discount(
            distinct_volumes=price.discount.distinct_volumes,
            percent=contract.Percent(price.discount.percent),
            base_cents=price.discount.base_cents,
            amount_cents=price.discount.amount_cents,
        ),
        total_cents=price.total_cents,
        judge=judge(q.judgement, threshold=threshold),
        usage=usage(q.report, engines=engines),
        created_at=q.created_at,
    )


def rejection(rej: pipeline.Rejection, *, engines: Literal["live", "fake"], threshold: float) -> contract.Problem:
    """The problem of a cart a stage refused, with the facts that decided and
    what the reading cost."""
    tokens, copies = rej.tokens, rej.copies
    return problem(422, contract.ProblemCode(rej.code), rej.detail).model_copy(
        update={
            "guard": guard(rej.guard) if rej.guard else None,
            "judge": judge(rej.judgement, threshold=threshold) if rej.judgement else None,
            "tokens": contract.Tokens(count=tokens.count, max=tokens.max) if tokens else None,
            "quantity": (contract.Quantity(title=copies.title, count=copies.count, max=copies.max) if copies else None),
            "usage": usage(rej.report, engines=engines),
        }
    )


def guard(v: pipeline.GuardVerdict) -> contract.GuardOutcome:
    return contract.GuardOutcome(
        verdict=contract.Verdict(v.verdict),
        confidence=v.confidence,
        probabilities={verdict.value: p for verdict, p in v.probabilities.items()},
        questions=contract.Questions(order=v.answers.order, steer=v.answers.steer),
    )


def judge(j: pipeline.Judgement, *, threshold: float) -> contract.JudgeOutcome:
    return contract.JudgeOutcome(
        attempts=j.attempts,
        score=j.score,
        threshold=threshold,
        checks=[contract.JudgeCheck(check=contract.Check(f.check), label=f.label, score=f.score) for f in j.findings],
    )


def usage(report: pipeline.Report, *, engines: Literal["live", "fake"]) -> contract.Usage:
    return contract.Usage(
        implementation=contract.Implementation.python,
        engines=contract.Engines(engines),
        duration_ms=report.ms,
        cost_usd=report.cost_usd,
        trace_id=report.trace_id,
        stages=[
            contract.StageUsage(
                stage=contract.Stage(u.stage),
                engine=u.engine,
                model=u.model,
                calls=u.calls,
                duration_ms=u.ms,
                cost_usd=u.cost_usd,
                tokens=u.tokens,
            )
            for u in report.stages
        ],
    )
