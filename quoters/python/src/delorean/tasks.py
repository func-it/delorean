"""Calls side by side, the way every stage that asks several questions makes
them."""

import asyncio
from collections.abc import Coroutine, Iterable
from typing import Any


async def all_of[T](calls: Iterable[Coroutine[Any, Any, T]], *, limit: int | None = None) -> list[T]:
    """Awaits every call side by side, at most `limit` at once, and returns
    their results in the order of the calls. The first failure cancels the
    others and is raised as is: one missing answer fails the whole set."""
    calls = list(calls)
    gate = asyncio.Semaphore(limit or len(calls) or 1)

    async def gated(call: Coroutine[Any, Any, T]) -> T:
        async with gate:
            return await call

    try:
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(gated(call)) for call in calls]
    except BaseExceptionGroup as failures:
        raise failures.exceptions[0] from None
    finally:
        # a call cancelled before its turn never started: closing it says so,
        # where the garbage collector would warn it was never awaited
        for call in calls:
            call.close()
    return [task.result() for task in tasks]
