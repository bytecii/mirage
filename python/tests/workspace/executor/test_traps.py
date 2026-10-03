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

import pytest

from mirage.io import IOResult
from mirage.workspace import Workspace
from mirage.workspace.executor.traps import finish_shell
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


@pytest.mark.asyncio
async def test_cleanup_is_awaited_and_preserves_body_status_and_io():
    session = Session(session_id="test", exit_trap="cleanup", eval_depth=3)
    entered, release = asyncio.Event(), asyncio.Event()

    async def evaluate(command, **opts):
        assert command == "cleanup"
        assert session.last_exit_code == 7
        entered.set()
        await release.wait()
        return IOResult(stdout=b"cleanup",
                        stderr=b"err",
                        exit_code=1,
                        writes={"/after": b"done"})

    body = IOResult(exit_code=7, reads={"/before": b"body"})
    task = asyncio.create_task(
        finish_shell(evaluate, session,
                     (b"body", body, ExecutionNode(exit_code=7))))
    await asyncio.wait_for(entered.wait(), 1)
    assert not task.done()
    release.set()
    out, io, node = await task
    assert out == b"bodycleanup"
    assert await io.materialize_stderr() == b"err"
    assert io.exit_code == node.exit_code == session.last_exit_code == 7
    assert io.reads == {"/before": b"body"}
    assert io.writes == {"/after": b"done"}
    assert session.eval_depth == 3
    assert session.exit_trap is None


@pytest.mark.asyncio
async def test_cancel_during_cleanup_unwinds_without_orphan_work():
    session = Session(session_id="test", exit_trap="cleanup", eval_depth=3)
    entered, stopped = asyncio.Event(), asyncio.Event()

    async def evaluate(command, **opts):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
        return IOResult()

    task = asyncio.create_task(
        finish_shell(evaluate, session, (None, IOResult(), ExecutionNode())))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stopped.is_set()
    assert session.eval_depth == 3
    assert not session.running_exit_trap
    assert session.exit_trap is None


@pytest.mark.asyncio
async def test_registration_lives_across_execute_calls_until_explicit_exit():
    ws = Workspace(resources={})
    try:
        first = await ws.execute("trap 'echo cleanup:$?' EXIT; echo body")
        assert await first.stdout_str() == "body\n"
        listing = await ws.execute("trap -p")
        assert await listing.stdout_str() == "trap -- 'echo cleanup:$?' EXIT\n"
        ended = await ws.execute("exit 7")
        assert ended.exit_code == 7
        assert await ended.stdout_str() == "cleanup:7\n"
        later = await ws.execute("trap -p; echo alive")
        assert await later.stdout_str() == "alive\n"
    finally:
        await ws.close()
