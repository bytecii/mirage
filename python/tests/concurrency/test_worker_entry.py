import asyncio
import operator

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
