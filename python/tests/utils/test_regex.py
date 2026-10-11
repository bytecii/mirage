import re
from unittest.mock import AsyncMock

import pytest

from mirage.concurrency.worker import Worker
from mirage.utils.regex import AsyncRegex


@pytest.mark.asyncio
async def test_buffered_subjects_share_a_request_and_the_invocation_worker(
    monkeypatch,
):
    worker = Worker()
    calls = AsyncMock(wraps=worker.call)
    monkeypatch.setattr(worker, "call", calls)
    try:
        for _ in range(2):
            pattern = AsyncRegex(re.compile("x"), worker=worker)
            await pattern.prepare("x", lambda: ["xx", "no match"])
            await pattern.prepare("xx")
            assert len(list(pattern.finditer("xx"))) == 2
            assert pattern.search("no match") is None
            await pattern.close()
        assert calls.call_count == 2
        assert (
            worker._process is not None and worker._process.returncode is None
        )
    finally:
        await worker.close()
