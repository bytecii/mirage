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
from mirage.resource.ram import RAMResource
from mirage.shell.console import Channel
from mirage.shell.job_table import Job, JobStatus, JobTable
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.executor.jobs import (handle_disown, handle_fg,
                                            handle_jobs, handle_kill,
                                            handle_ps, handle_wait)
from mirage.workspace.types import ExecutionNode


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_loop_body_streams_before_the_job_finishes():
    ws = _workspace()
    try:
        await ws.execute("for i in 1 2; do echo $i; sleep 3600; done &")
        job = ws.job_table.get(1)
        assert job is not None
        await asyncio.wait_for(job.console.store.wait(0), 2)
        assert job.status is JobStatus.RUNNING
        assert await job.console.snapshot(Channel.STDOUT) == b"1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_redirected_output_goes_to_the_file_not_the_console():
    ws = _workspace()
    try:
        await ws.execute("echo hi > /m/f.txt &")
        job = await ws.job_table.wait(1)
        written = await (await ws.execute("cat /m/f.txt")).stdout_str()
        assert await job.console.snapshot(Channel.STDOUT) == b""
        assert written == "hi\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stderr_is_routed_to_its_own_channel():
    ws = _workspace()
    try:
        await ws.execute("echo err >&2 &")
        job = await ws.job_table.wait(1)
        assert await job.console.snapshot(Channel.STDOUT) == b""
        assert await job.console.snapshot(Channel.STDERR) == b"err\n"
    finally:
        await ws.close()


async def _emit_and_settle(
        job: Job,
        stdout: bytes = b"",
        stderr: bytes = b"",
        exit_code: int = 0) -> tuple[IOResult, ExecutionNode]:
    """A runner that prints to its console and ends with a status.

    Args:
        job (Job): the job being run.
        stdout (bytes): what the job prints on stdout.
        stderr (bytes): what the job prints on stderr.
        exit_code (int): the job's exit status.
    """
    if stdout:
        await job.console.emit(Channel.STDOUT, stdout)
    if stderr:
        await job.console.emit(Channel.STDERR, stderr)
    return IOResult(exit_code=exit_code), ExecutionNode()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


def _submit_settled(table: JobTable,
                    command: str = "foo",
                    stdout: bytes = b"",
                    stderr: bytes = b"",
                    exit_code: int = 0) -> Job:
    return table.submit(command=command,
                        run=partial(_emit_and_settle,
                                    stdout=stdout,
                                    stderr=stderr,
                                    exit_code=exit_code),
                        cwd="/")


def _submit_pending(table: JobTable, command: str = "sleep") -> Job:
    return table.submit(command=command, run=_run_forever, cwd="/")


@pytest.mark.asyncio
async def test_wait_without_an_id_waits_for_every_job():
    table = JobTable()
    job = _submit_settled(table)
    _, io, node = await handle_wait(table, ["wait"])
    assert io.exit_code == 0
    assert node.command == "wait"
    # Bare `wait` adopts and reaps, so the table entry is gone but the
    # job object itself has settled.
    assert table.get(job.id) is None
    assert job.status == JobStatus.COMPLETED


@pytest.mark.asyncio
async def test_wait_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "abc"])
    assert io.exit_code == 1
    assert b"not a pid or valid job spec" in io.stderr


@pytest.mark.asyncio
async def test_wait_rejects_an_unknown_job_id():
    _, io, _ = await handle_wait(JobTable(), ["wait", "999"])
    assert io.exit_code == 127
    assert b"not a child of this shell" in io.stderr


@pytest.mark.asyncio
async def test_wait_adopts_the_awaited_jobs_output_and_exit_code():
    table = JobTable()
    job = _submit_settled(table, stdout=b"out", stderr=b"done", exit_code=3)
    stdout, io, _ = await handle_wait(table, ["wait", str(job.id)])
    assert stdout == b"out"
    assert io.exit_code == 3
    assert io.stderr == b"done"


@pytest.mark.asyncio
async def test_wait_accepts_the_percent_job_id_spelling():
    table = JobTable()
    job = _submit_settled(table)
    _, io, _ = await handle_wait(table, ["wait", f"%{job.id}"])
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_kill_rejects_a_missing_operand():
    _, io, _ = await handle_kill(JobTable(), ["kill"])
    assert io.exit_code == 1
    assert b"usage" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_a_non_numeric_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "abc"])
    assert io.exit_code == 1
    assert b"invalid job id" in io.stderr


@pytest.mark.asyncio
async def test_kill_rejects_an_unknown_job_id():
    _, io, _ = await handle_kill(JobTable(), ["kill", "999"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr


@pytest.mark.asyncio
async def test_kill_marks_a_known_job_killed():
    table = JobTable()
    job = _submit_pending(table)
    _, io, _ = await handle_kill(table, ["kill", str(job.id)])
    assert io.exit_code == 0
    assert table.get(job.id).status == JobStatus.KILLED


@pytest.mark.asyncio
async def test_jobs_prints_nothing_when_the_table_is_empty():
    out, io, _ = await handle_jobs(JobTable(), ["jobs"])
    assert out == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_jobs_lists_id_status_and_command():
    table = JobTable()
    done = _submit_settled(table, command="foo")
    pending = _submit_pending(table, command="bar")
    await table.wait(done.id)
    out, _, _ = await handle_jobs(table, ["jobs"])
    assert b"[1] completed foo" in out
    assert b"[2] running bar" in out
    await table.kill(pending.id)


@pytest.mark.asyncio
async def test_jobs_reaps_the_completed_entries_it_reported():
    table = JobTable()
    job = _submit_settled(table)
    await table.wait(job.id)
    await handle_jobs(table, ["jobs"])
    assert table.list_jobs() == []


@pytest.mark.asyncio
async def test_ps_lists_only_the_running_jobs():
    table = JobTable()
    job = _submit_pending(table)
    done = _submit_settled(table, command="foo")
    await table.wait(done.id)
    out, _, _ = await handle_ps(table, ["ps"])
    assert out == b"1\tsleep\n"
    await table.kill(job.id)


@pytest.mark.asyncio
async def test_ps_prints_nothing_when_no_job_is_running():
    out, _, _ = await handle_ps(JobTable(), ["ps"])
    assert out == b""


@pytest.mark.asyncio
async def test_fg_without_an_operand_reports_when_there_is_no_job():
    _, io, _ = await handle_fg(JobTable(), ["fg"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: current: no such job\n"


@pytest.mark.asyncio
async def test_fg_rejects_an_unknown_job_id_with_the_operand_as_typed():
    _, io, _ = await handle_fg(JobTable(), ["fg", "%9"])
    assert io.exit_code == 1
    assert io.stderr == b"fg: %9: no such job\n"


@pytest.mark.asyncio
async def test_fg_echoes_the_command_line_then_adopts_the_jobs_result():
    table = JobTable()
    job = _submit_settled(table, command="slow", stdout=b"body", exit_code=7)
    stdout, io, _ = await handle_fg(table, ["fg", str(job.id)])
    assert stdout == b"slow\nbody"
    assert io.exit_code == 7


@pytest.mark.asyncio
async def test_disown_drops_a_job_from_the_table():
    table = JobTable()

    async def _run(job):
        await asyncio.sleep(0.05)
        return IOResult(), ExecutionNode(command="j", exit_code=0)

    table.submit("sleep", _run, cwd="/")
    _, io, _ = await handle_disown(table, ["disown"])
    assert io.exit_code == 0
    assert table.list_jobs() == []
    await table.kill_all()


@pytest.mark.asyncio
async def test_disown_unknown_job_and_bad_option():
    _, io, _ = await handle_disown(JobTable(), ["disown", "%9"])
    assert io.exit_code == 1
    assert b"no such job" in io.stderr
    _, io, _ = await handle_disown(JobTable(), ["disown", "-x"])
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_wait_n_returns_first_finisher():
    table = JobTable()

    async def _quick(job):
        return IOResult(exit_code=3), ExecutionNode(command="q", exit_code=3)

    table.submit("q", _quick, cwd="/")
    _, io, _ = await handle_wait(table, ["wait", "-n"])
    assert io.exit_code == 3


@pytest.mark.asyncio
async def test_wait_n_with_no_jobs_is_127():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-n"])
    assert io.exit_code == 127


@pytest.mark.asyncio
async def test_wait_bad_option():
    _, io, _ = await handle_wait(JobTable(), ["wait", "-x"])
    assert io.exit_code == 2
    assert b"invalid option" in io.stderr


@pytest.mark.asyncio
async def test_wait_p_names_the_job_whose_status_is_returned():
    """`wait id1 id2` answers with the last id's status, so `-p` names
    that job however many ids were waited for."""
    ws = Workspace({"data": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("(exit 3) & (exit 5) & wait -p V %1 %2; "
                          "echo rc=$? V=$V")
    assert (await io.stdout_str()) == "rc=5 V=2\n"
    await ws.close()


@pytest.mark.asyncio
async def test_wait_p_with_no_operand_leaves_the_variable_unset():
    """The no-operand form waits for everything and reports no one job,
    so bash leaves the variable unset (having cleared it first)."""
    ws = Workspace({"data": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("(exit 0) & V=stale; wait -p V; "
                          "echo \"V=[${V-UNSET}]\"")
    assert (await io.stdout_str()) == "V=[UNSET]\n"
    await ws.close()


@pytest.mark.asyncio
async def test_background_does_not_consume_stdin():
    mem = RAMResource()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    try:
        ws.get_session(ws.default_session_id).cwd = "/data"
        io = await ws.execute("sleep 0 & cat", stdin=b"hello\n")
        assert (await io.stdout_str()).strip() == "hello"

    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancelled_wait_n_releases_waiters_without_killing_jobs():
    table = JobTable()
    jobs = [_submit_pending(table), _submit_pending(table)]
    before = asyncio.all_tasks()
    waiting = asyncio.create_task(handle_wait(table, ["wait", "-n"]))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    waiting.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await waiting
        assert not (asyncio.all_tasks() - before)
        assert all(job.status is JobStatus.RUNNING for job in jobs)
    finally:
        await table.kill_all()


@pytest.mark.asyncio
async def test_wait_n_cleans_losing_waiters():
    table = JobTable()
    job = _submit_pending(table)
    loser = _submit_pending(table)
    before = asyncio.all_tasks()
    waiting = asyncio.create_task(handle_wait(table, ["wait", "-n"]))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await table.kill(job.id)
    try:
        _, result, _ = await waiting
        assert result.exit_code == 137
        assert loser.status is JobStatus.RUNNING
        assert not (asyncio.all_tasks() - before)
    finally:
        await table.kill_all()


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["wait", "wait -n", "fg"])
async def test_execute_cancellation_interrupts_job_wait(command):
    ws = _workspace()
    cancel = asyncio.Event()
    try:
        await ws.execute("sleep 3600 &")
        waiting = asyncio.create_task(ws.execute(command, cancel=cancel))
        await asyncio.sleep(0)
        cancel.set()
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(waiting, 2)
        assert ws.job_table.get(1).status is JobStatus.RUNNING
    finally:
        await ws.close()
