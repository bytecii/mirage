# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
from collections.abc import Awaitable
from typing import TypeVar


class MirageAbortError(RuntimeError):

    def __init__(self) -> None:
        super().__init__("execute aborted")


T = TypeVar("T")


async def cancellable(awaitable: Awaitable[T],
                      cancel: asyncio.Event | None) -> T:
    """Await owned work and join its cleanup when the caller cancels.

    Args:
        awaitable (Awaitable[T]): work whose lifetime belongs to this call.
        cancel (asyncio.Event | None): optional cooperative cancellation event.
    """
    if cancel is None:
        return await awaitable
    work = asyncio.ensure_future(awaitable)
    cancelled = asyncio.create_task(cancel.wait())
    tasks = (work, cancelled)
    try:
        if cancel.is_set():
            raise MirageAbortError()
        done, _ = await asyncio.wait(tasks,
                                     return_when=asyncio.FIRST_COMPLETED)
        if cancelled in done:
            raise MirageAbortError()
        return work.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def cancellable_sleep(seconds: float,
                            cancel: asyncio.Event | None = None) -> None:
    await cancellable(asyncio.sleep(seconds), cancel)
