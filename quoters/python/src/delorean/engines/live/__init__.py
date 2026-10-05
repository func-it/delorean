"""The pipeline's engines on real models, through OpenRouter: Jev for the
guard, the identification and the judge; two LLMs of different families for
the parse and the recount.

Two kinds of model, each for what it does well. Jev answers a typed question
with calibrated probabilities and never writes prose: it decides — is this a
cart, which film is this title, does the customer ask for this. It does not
count or extract (its own documentation: it recognises the shape instead of
counting), so the LLMs read the titles and quantities out of the free text
under a JSON schema, and the judge holds that reading against the text before
anything is priced.

What every engine keeps to:
- the customer's text is data, never instructions: it goes into Jev's state
  under a key named for what it is, into the LLM's user turn between tags,
  and every prompt says so;
- one request per independent judgement, all side by side: questions put in
  the same request colour one another;
- no retry in the request path, a person is waiting: a failure is an
  EngineError at once;
- any failure, and any answer outside the contract, is an EngineError.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import openai

from delorean.config import LiveSettings
from delorean.engines.live.jev import HEADERS, Jev
from delorean.engines.live.questions import JevGuard, JevIdentifier, JevJudge
from delorean.engines.live.reader import LlmReader
from delorean.lru import Lru
from delorean.pipeline import Engines
from delorean.prompts import Prompts
from delorean.telemetry import Tracer


@asynccontextmanager
async def open_live_engines(settings: LiveSettings, prompts: Prompts, tracer: Tracer) -> AsyncIterator[Engines]:
    """The live engines, and the connections they hold until the block ends.
    One client per engine, each with its own pool, for the whole process: its
    connections stay alive from a quote to the next. Nothing is called before
    the first quote."""
    async with (
        # Jev's pool keeps as many connections as a set sends at once, times a
        # few quotes under way
        httpx.AsyncClient(timeout=settings.model_timeout, limits=httpx.Limits(max_keepalive_connections=64)) as http,
        _llm(settings.openrouter_api_key, settings.parse_base_url, settings.model_timeout) as parse_llm,
        _llm(settings.openrouter_api_key, settings.recount_base_url, settings.model_timeout) as recount_llm,
    ):
        jev = Jev(
            key=settings.openrouter_api_key,
            model=settings.jev_model,
            client=http,
            tracer=tracer,
            timeout=settings.model_timeout,
        )
        yield Engines(
            name="live",
            guard=JevGuard(jev, prompts.guard),
            parser=LlmReader(
                client=parse_llm,
                model=settings.parse_model,
                effort=settings.parse_effort,
                prompt=prompts.parse_films if settings.parse_identifies else prompts.parse,
                names_films=settings.parse_identifies,
                tracer=tracer,
                timeout=settings.model_timeout,
            ),
            # the recount reads parse.json, always: a second opinion on the count
            recounter=LlmReader(
                client=recount_llm,
                model=settings.recount_model,
                effort=settings.recount_effort,
                prompt=prompts.parse,
                tracer=tracer,
                timeout=settings.model_timeout,
            ),
            identifier=JevIdentifier(
                jev,
                prompts.identify,
                version=prompts.versions["identify"],
                cache=Lru(settings.identify_cache_size),
            ),
            judge=JevJudge(jev, prompts.judge),
            caches_identifications=settings.identify_cache_size > 0,
        )


def _llm(key: str, base_url: str, timeout: float) -> openai.AsyncOpenAI:
    """An OpenAI-compatible API: OpenRouter, or a local server to bench.
    timeout bounds each phase of a call (connecting, writing, reading): the
    readers and Jev also bound the whole call themselves (MODEL_TIMEOUT)."""
    return openai.AsyncOpenAI(api_key=key, base_url=base_url, default_headers=HEADERS, timeout=timeout, max_retries=0)
