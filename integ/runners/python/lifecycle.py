import asyncio
import os
import signal
import tempfile
from pathlib import Path

from harness import stat_check

from mirage.shell.job_table import JobStatus
from mirage.workspace.abort import MirageAbortError


def running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def read_pid(path: Path, task: asyncio.Task | None) -> int:
    while True:
        if path.exists() and path.read_text():
            return int(path.read_text())
        if task is not None and task.done():
            result = await task
            raise AssertionError(
                f"interpreter exited before readiness: {result.exit_code}: "
                f"{await result.stdout_str()} {await result.stderr_str()}")
        await asyncio.sleep(0.01)


async def stopped(pid: int) -> None:
    while running(pid):
        await asyncio.sleep(0.01)


async def run_lifecycle(ws,
                        case: dict) -> tuple[int, str, str, float, str | None]:
    """Wait for interpreter readiness before cancellation or teardown."""
    pid = None
    task = None
    with tempfile.TemporaryDirectory(
            prefix="mirage-shell-lifecycle-") as directory:
        path = Path(directory) / "pid"
        cancel = asyncio.Event()
        try:
            if case["lifecycle"] == "cancel":
                task = asyncio.create_task(
                    ws.execute(case["command"],
                               cancel=cancel,
                               env={"MIRAGE_PID_FILE": str(path)}))
            else:
                await ws.execute("{ " + case["command"] + "; } &",
                                 env={"MIRAGE_PID_FILE": str(path)})
            pid = await asyncio.wait_for(read_pid(path, task), 10)
            if case["lifecycle"] == "cancel":
                cancel.set()
                try:
                    await asyncio.wait_for(task, 5)
                except MirageAbortError:
                    # Cancellation is the expected result, after child cleanup.
                    pass
                else:
                    raise AssertionError(
                        "canceled execute did not report cancellation")
            else:
                job = ws.job_table.get(1)
                assert job is not None
                if case["lifecycle"] == "close":
                    await asyncio.wait_for(ws.close(), 5)
                else:
                    result = await ws.execute("kill %1")
                    assert result.exit_code == 0
                await asyncio.wait_for(job.console.wait_finished(), 5)
                assert job.status is JobStatus.KILLED
            await asyncio.wait_for(stopped(pid), 5)
            return 0, "started\nstopped\n", "", 0.0, (await stat_check(
                ws, case["check"]) if "check" in case else None)
        finally:
            cancel.set()
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if pid is not None and running(pid):
                os.kill(pid, signal.SIGKILL)
            await asyncio.wait_for(ws.close(), 5)
