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
from functools import partial

import pytest

from mirage.io import IOResult
from mirage.shell.console import Channel, JobConsole, RAMConsoleStore
from mirage.shell.console.types import ConsoleChunk, ReadResult
from mirage.shell.job_table.table import JobTable
from mirage.shell.job_table.types import Job, JobStatus
from mirage.workspace.types import ExecutionNode


class _GatedStore:
    """A store whose appends park until the test opens the gate.

    Stands in for a store that genuinely suspends (Redis) or a waiter on
    another loop: the window between a job's status flipping and its
    final chunks landing becomes arbitrarily wide.
    """

    def __init__(self, gate: asyncio.Event) -> None:
        self._gate = gate
        self._inner = RAMConsoleStore()

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        await self._gate.wait()
        return await self._inner.append(channel, data)

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        return await self._inner.read_from(seq, limit)

    @property
    def closed(self) -> bool:
        return self._inner.closed

    async def wait(self, seq: int) -> None:
        await self._inner.wait(seq)

    async def close(self) -> None:
        await self._inner.close()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


def _tracked_ram_console(stores: list[RAMConsoleStore],
                         job_id: int) -> JobConsole:
    """A console factory that remembers the stores it built.

    Args:
        stores (list[RAMConsoleStore]): where built stores are recorded.
        job_id (int): the job the console is being built for.
    """
    store = RAMConsoleStore()
    stores.append(store)
    return JobConsole(store=store)


def _submit_gated(table: JobTable, gate: asyncio.Event) -> Job:
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
    job.console = JobConsole(store=_GatedStore(gate))
    return job


@pytest.mark.asyncio
async def test_wait_joins_a_kill_still_appending_its_marker():
    """``wait`` must not return between the status flip and the appends.

    ``kill`` sets KILLED before emitting ``Killed`` and the ending
    chunk, so a wait that trusts the status field lets the caller
    snapshot and reap without the marker. Joining on the console's
    ending chunk closes the window.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = _submit_gated(table, gate)
    kill_task = asyncio.create_task(table.kill(job.id))
    await asyncio.sleep(0)
    assert job.status is JobStatus.KILLED
    waiter = asyncio.create_task(table.wait(job.id))
    await asyncio.sleep(0)
    # The status has flipped but the marker has not landed; a wait that
    # returned here would snapshot without it.
    assert not waiter.done()
    gate.set()
    await asyncio.wait_for(kill_task, 2)
    waited = await asyncio.wait_for(waiter, 2)
    assert await waited.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_wait_all_joins_a_killed_job_still_appending():
    """``wait_all`` covers killed jobs too, not only the running ones.

    Bare ``wait`` snapshots every console right after ``wait_all``
    returns, so a killed-but-mid-append job skipped by a running-only
    filter would lose its marker the same way.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = _submit_gated(table, gate)
    kill_task = asyncio.create_task(table.kill(job.id))
    await asyncio.sleep(0)
    assert job.status is JobStatus.KILLED
    all_waiter = asyncio.create_task(table.wait_all())
    await asyncio.sleep(0)
    assert not all_waiter.done()
    gate.set()
    await asyncio.wait_for(kill_task, 2)
    await asyncio.wait_for(all_waiter, 2)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_close_consoles_releases_factory_stores():
    """Teardown closes what the factory built, and only that."""
    stores: list[RAMConsoleStore] = []
    table = JobTable(console_factory=partial(_tracked_ram_console, stores))
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
    await table.kill(job.id)
    await table.close_consoles()
    assert len(stores) == 1
    assert all(s.closed for s in stores)


@pytest.mark.asyncio
async def test_close_consoles_leaves_default_consoles_alone():
    table = JobTable()
    job = table.submit(command="deaf", run=_run_forever, cwd="/")
    await table.kill(job.id)
    await table.close_consoles()
    assert job.console.store.closed is False


@pytest.mark.asyncio
async def test_settle_kill_marker_survives_second_cancel():
    """A cancel landing while the marker is mid-write must not lose it.

    The runner's task is cancelled directly (not via ``kill``), enters
    the settle branch, and parks on the gated append; a second cancel
    then hits the task. The shield keeps the marker write running, so
    once the gate opens the console still ends with the marker and the
    killed outcome. Without the shield the second cancel aborts the
    emit and the ending chunk never lands, stranding every reader.
    """
    gate = asyncio.Event()
    table = JobTable()
    job = _submit_gated(table, gate)
    await asyncio.sleep(0)
    assert job.task is not None
    job.task.cancel()
    await asyncio.sleep(0.01)
    assert job.status is JobStatus.KILLED
    job.task.cancel()
    await asyncio.sleep(0.01)
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(job.task, 2)
    await asyncio.wait_for(job.console.wait_finished(), 2)
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


async def _failing_run(job):
    raise RuntimeError("resource API error")


async def _successful_run(job):
    await job.console.emit(Channel.STDOUT, b"hello")
    return IOResult(exit_code=0), ExecutionNode(command="echo hello",
                                                exit_code=0)


async def _never_ending_run(job):
    await job.console.emit(Channel.STDOUT, b"partial")
    await asyncio.Event().wait()
    return IOResult(exit_code=0), ExecutionNode(command="noisy", exit_code=0)


@pytest.mark.asyncio
async def test_wait_handles_task_exception():
    table = JobTable()
    table.submit(command="bad_cmd", run=_failing_run, cwd="/")
    job = await table.wait(1)
    assert job.status == JobStatus.COMPLETED
    assert job.exit_code == 1
    stderr = await job.console.snapshot(Channel.STDERR)
    assert b"resource API error" in stderr


@pytest.mark.asyncio
async def test_wait_all_survives_failing_task():
    table = JobTable()
    table.submit(command="bad", run=_failing_run, cwd="/")
    table.submit(command="good", run=_successful_run, cwd="/")
    jobs = await table.wait_all()
    assert len(jobs) == 2
    bad = table.get(1)
    good = table.get(2)
    assert bad.exit_code == 1
    assert good.exit_code == 0
    assert await good.console.snapshot(Channel.STDOUT) == b"hello"


@pytest.mark.asyncio
async def test_wait_successful_task():
    table = JobTable()
    table.submit(command="echo hello", run=_successful_run, cwd="/")
    job = await table.wait(1)
    assert job.status == JobStatus.COMPLETED
    assert job.exit_code == 0
    assert await job.console.snapshot(Channel.STDOUT) == b"hello"


@pytest.mark.asyncio
async def test_kill_keeps_output_produced_before_the_kill():
    table = JobTable()
    job = table.submit(command="noisy", run=_never_ending_run, cwd="/")
    while not await job.console.snapshot(Channel.STDOUT):
        await asyncio.sleep(0)

    assert await table.kill(1)

    assert job.status == JobStatus.KILLED
    assert job.exit_code == 137
    assert await job.console.snapshot(Channel.STDOUT) == b"partial"
    assert await job.console.snapshot(Channel.STDERR) == b"Killed"


@pytest.mark.asyncio
async def test_kill_returns_a_settled_job():
    table = JobTable()
    job = table.submit(command="noisy", run=_never_ending_run, cwd="/")

    assert await table.kill(1)

    assert job.console.finished
    assert job.status == JobStatus.KILLED


@pytest.mark.asyncio
async def test_kill_is_false_for_unknown_and_finished_jobs():
    table = JobTable()
    table.submit(command="echo hello", run=_successful_run, cwd="/")
    await table.wait(1)

    assert not await table.kill(1)
    assert not await table.kill(404)


@pytest.mark.asyncio
async def test_kill_all_stops_every_running_job():
    table = JobTable()
    table.submit(command="a", run=_never_ending_run, cwd="/")
    table.submit(command="b", run=_never_ending_run, cwd="/")

    killed = await table.kill_all()

    assert len(killed) == 2
    assert table.running_jobs() == []


@pytest.mark.asyncio
async def test_kill_settles_a_runner_that_ignores_cancellation():
    release = asyncio.Event()
    started = asyncio.Event()

    async def run(job: Job) -> tuple[IOResult, ExecutionNode]:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
        return IOResult(), ExecutionNode()

    table = JobTable()
    job = table.submit(command="deaf", run=run, cwd="/")
    await started.wait()
    try:
        assert await asyncio.wait_for(table.kill(job.id), 2)
        assert job.console.finished
        assert job.status is JobStatus.KILLED
        assert job.exit_code == 137
    finally:
        release.set()
        await job.task
    assert job.status is JobStatus.KILLED
    assert job.exit_code == 137
