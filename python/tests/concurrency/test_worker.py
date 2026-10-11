import asyncio
import operator
import time

import pytest

from mirage.concurrency.worker import Worker


@pytest.mark.asyncio
async def test_worker_reuses_serialized_calls_and_recovers_after_an_error():
    worker = Worker()
    try:
        assert await asyncio.gather(
            worker.call(operator.add, 1, 2), worker.call(operator.mul, 3, 4)
        ) == [3, 12]
        with pytest.raises(ZeroDivisionError):
            await worker.call(operator.truediv, 1, 0)
        assert await worker.call(operator.add, 4, 5) == 9
    finally:
        await worker.close()


@pytest.mark.asyncio
async def test_cancel_kills_and_joins_the_owned_process():
    worker = Worker()
    await worker.call(time.monotonic)
    process = worker._process
    task = asyncio.create_task(worker.call(time.sleep, 120))
    try:
        await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert process is not None and process.returncode is not None
        assert worker._process is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await worker.close()
