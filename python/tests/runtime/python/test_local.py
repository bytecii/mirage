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

from mirage.runtime.python import LocalRuntime
from mirage.runtime.types import RunArgs


def test_local_runs_on_host_interpreter():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="print(21 * 2)")))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


def test_local_passes_argv():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import sys; print(sys.argv[1:])", args=["a", "b"])))
    assert result.stdout == b"['a', 'b']\n"


def test_local_env_overlays_host():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import os; print(os.environ['MY_VAR'])",
                    env={"MY_VAR": "v1"})))
    assert result.stdout == b"v1\n"


def test_local_stdin():
    runtime = LocalRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import sys; print(sys.stdin.read().upper())",
                    stdin=b"hello")))
    assert result.stdout == b"HELLO\n"


def test_local_exit_code_and_stderr():
    runtime = LocalRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="1/0")))
    assert result.exit_code == 1
    assert b"ZeroDivisionError" in result.stderr


def test_local_name():
    assert LocalRuntime().name == "local"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["cancel", "close"])
async def test_local_teardown_joins_subprocess(monkeypatch, action):
    runtime = LocalRuntime()
    started = asyncio.Event()
    processes = []
    spawn = asyncio.create_subprocess_exec

    async def track_spawn(*args, **kwargs):
        process = await spawn(*args, **kwargs)
        processes.append(process)
        started.set()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", track_spawn)
    task = asyncio.create_task(
        runtime.run(RunArgs(code="import time; time.sleep(30)")))
    await asyncio.wait_for(started.wait(), 5)
    try:
        if action == "cancel":
            task.cancel()
        else:
            await asyncio.wait_for(runtime.close(), 5)
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert all(process.returncode is not None for process in processes)
    finally:
        await runtime.close()


def test_reach_is_process():
    # The subprocess sees the host filesystem and network: doors the
    # workspace gate never sees, so a world holding this runtime may
    # not claim a sandbox.
    assert LocalRuntime.reach == "process"
