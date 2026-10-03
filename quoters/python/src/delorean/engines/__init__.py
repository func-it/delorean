"""The engines that answer the pipeline's ports: `live` on real models through
OpenRouter, `fake` deterministic stand-ins for tests."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from delorean.config import Settings
from delorean.engines import fake
from delorean.engines.live import open_live_engines
from delorean.pipeline import Engines
from delorean.prompts import Prompts
from delorean.telemetry import Tracer


@asynccontextmanager
async def open_engines(settings: Settings, prompts: Prompts, tracer: Tracer) -> AsyncIterator[Engines]:
    """The engines settings.engines names, for as long as the block lasts."""
    if settings.engines == "fake":
        yield fake.engines(fake.Pace(latency=settings.fake_latency, cpu_ms=settings.fake_cpu_ms))
        return
    async with open_live_engines(settings.live, prompts, tracer) as engines:
        yield engines
