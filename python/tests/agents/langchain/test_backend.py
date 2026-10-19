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
import base64
import subprocess
import sys

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.langchain.backend import LangchainWorkspace
from mirage.policy import CommandContext, Deny, Policy

CONTENTION_REPRO = """
import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.agno import MirageToolkit
from mirage.agents.langchain import LangchainWorkspace
from mirage.context import reset_current_session, set_current_session
from mirage.fuse.fs import MirageFS

kind, mode = sys.argv[1:]
ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
ws.create_session("s")
if kind == "langchain":
    adapter = LangchainWorkspace(ws, session_id="s")
    sync = adapter.execute
    async_name = "aexecute"
else:
    adapter = MirageToolkit(ws, session_id="s")
    sync = adapter.shell
    async_name = "ashell"

async def main():
    await ws.shell("echo seed", session_id="s")
    lock = ws._session_mgr.line_lock_for("s")
    await lock.acquire()
    try:
        if mode == "loop":
            try:
                sync("echo hi")
            except RuntimeError as exc:
                assert "await " + async_name in str(exc), str(exc)
            else:
                raise AssertionError("owner-thread sync call was allowed")
        elif mode == "nested":
            token = set_current_session(ws.get_session("s"), owner=ws._session_mgr)
            try:
                result = await asyncio.to_thread(sync, "echo nested")
                text = result.output if kind == "langchain" else result
                assert text.strip() == "nested", text
            finally:
                reset_current_session(token)
        else:
            worker = asyncio.create_task(asyncio.to_thread(sync, "echo hi"))
            while not lock._waiters:
                await asyncio.sleep(0)
            assert not worker.done()
    finally:
        lock.release()
    if mode == "thread":
        result = await worker
        text = result.output if kind == "langchain" else result
        assert text.strip() == "hi", text
    await lock.acquire()
    next_call = asyncio.create_task(ws.shell("echo next", session_id="s"))
    while not lock._waiters:
        await asyncio.sleep(0)
    lock.release()
    assert (await (await next_call).stdout_str()).strip() == "next"
    await ws.close()

if mode == "borrowed_context":
    async def borrowed_context():
        owner = asyncio.get_running_loop()
        await ws.shell("echo seed", session_id="s")
        with ws:
            with open("/context.txt", "w") as handle:
                handle.write("context")
            result = await asyncio.to_thread(sync, "cat /context.txt")
            text = result.output if kind == "langchain" else result
            assert text.strip() == "context"
            assert ws._sync_bridge._loop is owner
        assert owner.is_running()

    asyncio.run(borrowed_context())
elif mode == "context_close":
    with ws:
        sync("echo context")
        owner = ws._sync_bridge._loop
        asyncio.run(ws.close())
    assert owner.is_closed()
elif mode == "context":
    first_entered, second_entered = threading.Event(), threading.Event()
    first_release, second_release = asyncio.Event(), asyncio.Event()
    original_shell = ws._shell

    async def controlled_shell(command, *args, **kwargs):
        if command == "echo first":
            first_entered.set()
            await first_release.wait()
        elif command == "echo second":
            second_entered.set()
            await second_release.wait()
        return await original_shell(command, *args, **kwargs)

    ws._shell = controlled_shell
    with ThreadPoolExecutor(2) as pool:
        with ws:
            owner = ws._vfs_loop
            first = pool.submit(sync, "echo first")
            assert first_entered.wait(3)
            second = pool.submit(sync, "echo second")
            assert second_entered.wait(3)
            owner.call_soon_threadsafe(first_release.set)
            result = first.result(timeout=3)
            text = result.output if kind == "langchain" else result
            assert text.strip() == "first"
            owner.call_soon_threadsafe(second_release.set)
            result = second.result(timeout=3)
            text = result.output if kind == "langchain" else result
            assert text.strip() == "second"
    assert owner.is_closed()
elif mode in ("fuse", "fuse_first"):
    fs = MirageFS(ws.vfs)
    try:
        if mode == "fuse_first":
            fs.getattr("/")
        result = sync("echo before")
        text = result.output if kind == "langchain" else result
        assert text.strip() == "before"
        owner = ws._sync_bridge._loop
        assert owner is not fs._loop
        fs.getattr("/")
        sync("echo file > /old")
        fs.renamex("/old", "/new")
        result = sync("echo after")
        text = result.output if kind == "langchain" else result
        assert text.strip() == "after"
        assert ws._sync_bridge._loop is owner
    finally:
        asyncio.run(ws.close())
        fs._loop.call_soon_threadsafe(fs._loop.stop)
elif mode == "sync":
    result = sync("echo sync")
    text = result.output if kind == "langchain" else result
    assert text.strip() == "sync"
    owner = ws._sync_bridge._loop

    async def async_tool():
        if kind == "langchain":
            assert (await adapter.aexecute("echo async")).output.strip() == "async"
        else:
            assert (await adapter.ashell("echo async")).strip() == "async"

    asyncio.run(async_tool())
    with ws:
        assert sync("echo context")
    assert owner.is_closed()
else:
    asyncio.run(main())
"""


@pytest.mark.parametrize("kind", ["langchain", "agno"])
@pytest.mark.parametrize(
    "mode",
    [
        "loop",
        "thread",
        "sync",
        "nested",
        "context",
        "context_close",
        "borrowed_context",
        "fuse",
        "fuse_first",
    ],
)
def test_contended_sync_adapter_in_bounded_process(kind, mode):
    result = subprocess.run(
        [
            sys.executable,
            "-Werror::RuntimeWarning",
            "-c",
            CONTENTION_REPRO,
            kind,
            mode,
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Unclosed client session" not in result.stderr


@pytest.fixture
def workspace():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    yield ws
    asyncio.run(ws.close())


@pytest.fixture
def backend(workspace):
    return LangchainWorkspace(workspace)


def test_id(backend):
    assert backend.id == "mirage"


def test_custom_id(workspace):
    b = LangchainWorkspace(workspace, sandbox_id="custom")
    assert b.id == "custom"


@pytest.mark.asyncio
async def test_aexecute_echo(backend):
    resp = await backend.aexecute("echo hello")
    assert resp.exit_code == 0
    assert "hello" in resp.output


@pytest.mark.asyncio
async def test_aexecute_failing_command(backend):
    resp = await backend.aexecute("cat /nonexistent")
    assert resp.exit_code != 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("execute", ("echo nested",)),
        ("ls", ("/",)),
        ("read", ("/file",)),
        ("write", ("/file", "text")),
        ("edit", ("/file", "old", "new")),
        ("grep", ("pattern",)),
        ("glob", ("*",)),
        ("upload_files", ([("/file", b"text")],)),
        ("download_files", (["/file"],)),
    ],
)
async def test_sync_tool_recommends_async_inside_running_event_loop(
    backend, name, args
):
    with pytest.raises(RuntimeError, match=f"await a{name}"):
        getattr(backend, name)(*args)
    assert (await backend.aexecute("echo next")).output.strip() == "next"


@pytest.mark.asyncio
async def test_awrite_and_aread(backend):
    result = await backend.awrite("/test.txt", "hello world")
    assert result.error is None

    read_result = await backend.aread("/test.txt")
    assert read_result.error is None
    assert read_result.file_data == {
        "content": "hello world",
        "encoding": "utf-8",
    }


@pytest.mark.asyncio
async def test_aread_paginates_text_without_line_numbers(backend):
    await backend.awrite("/lines.txt", "zero\none\ntwo\nthree\n")

    result = await backend.aread("/lines.txt", offset=1, limit=2)

    assert result.error is None
    assert result.file_data == {
        "content": "one\ntwo\n",
        "encoding": "utf-8",
    }


@pytest.mark.asyncio
async def test_aread_reports_out_of_range_offset(backend):
    await backend.awrite("/lines.txt", "zero\none\n")

    result = await backend.aread("/lines.txt", offset=2)

    assert result.file_data is None
    assert result.error == "Line offset 2 exceeds file length (2 lines)"


@pytest.mark.asyncio
async def test_aread_encodes_pdf_as_base64(backend):
    content = b"%PDF-1.7\n\x00binary"
    await backend.aupload_files([("/document.pdf", content)])

    result = await backend.aread("/document.pdf")

    assert result.error is None
    assert result.file_data == {
        "content": base64.standard_b64encode(content).decode("ascii"),
        "encoding": "base64",
    }


@pytest.mark.asyncio
async def test_awrite_existing_file_errors(backend):
    await backend.awrite("/exists.txt", "first")
    result = await backend.awrite("/exists.txt", "second")
    assert result.error is not None


@pytest.mark.asyncio
async def test_aedit(backend):
    await backend.awrite("/edit.txt", "foo bar baz")
    result = await backend.aedit("/edit.txt", "bar", "qux")
    assert result.error is None
    read_result = await backend.aread("/edit.txt")
    assert read_result.file_data is not None
    assert "qux" in read_result.file_data["content"]
    assert "bar" not in read_result.file_data["content"]


@pytest.mark.asyncio
async def test_aedit_keeps_a_leading_bom(backend, workspace):
    await workspace.vfs.write("/bom.txt", "\ufefffoo bar baz".encode())
    result = await backend.aedit("/bom.txt", "bar", "BAR")
    assert result.error is None
    assert await workspace.vfs.read("/bom.txt") == "\ufefffoo BAR baz".encode()


@pytest.mark.asyncio
async def test_als(backend):
    await backend.awrite("/dir/a.txt", "a")
    await backend.awrite("/dir/b.txt", "b")
    result = await backend.als("/dir")
    assert result.entries is not None
    entries = result.entries
    paths = [e["path"] for e in entries]
    assert len(paths) == 2


@pytest.mark.asyncio
async def test_als_reports_command_errors(backend):
    result = await backend.als("/missing")

    assert result.entries is None
    assert result.error is not None


@pytest.mark.asyncio
async def test_agrep(backend):
    await backend.awrite(
        "/search.txt", "hello world\ngoodbye world\nhello again"
    )
    result = await backend.agrep("hello", path="/")
    assert result.matches is not None
    assert len(result.matches) >= 2


@pytest.mark.asyncio
async def test_agrep_single_file_keeps_path_and_line_numbers(backend):
    await backend.awrite("/log.txt", "one\nerror here\ntwo\nerror again\n")
    result = await backend.agrep("error", path="/log.txt")
    assert result.error is None
    assert result.matches == [
        {"path": "/log.txt", "line": 2, "text": "error here"},
        {"path": "/log.txt", "line": 4, "text": "error again"},
    ]


@pytest.mark.asyncio
async def test_agrep_max_count_truncates(backend):
    await backend.awrite("/search.txt", "hit\nhit\nhit")
    result = await backend.agrep("hit", path="/", max_count=2)

    assert result.matches is not None
    assert len(result.matches) == 2
    assert result.truncated is True


@pytest.mark.asyncio
async def test_agrep_max_count_exactly_is_complete(backend):
    await backend.awrite("/search.txt", "hit\nhit")
    result = await backend.agrep("hit", path="/", max_count=2)

    assert result.matches is not None
    assert len(result.matches) == 2
    assert result.truncated is False


@pytest.mark.asyncio
async def test_aglob(backend):
    await backend.awrite("/data/a.txt", "a")
    await backend.awrite("/data/b.py", "b")
    result = await backend.aglob("*.txt", path="/data")
    assert result.matches is not None
    entries = result.matches
    paths = [e["path"] for e in entries]
    assert any("a.txt" in p for p in paths)
    assert not any("b.py" in p for p in paths)


@pytest.mark.asyncio
async def test_aglob_reports_command_errors(backend):
    result = await backend.aglob("*.txt", path="/missing")

    assert result.matches is None
    assert result.error is not None


@pytest.mark.asyncio
async def test_execute_pipe(backend):
    await backend.awrite("/pipe.txt", "aaa\nbbb\nccc\naaa\n")
    resp = await backend.aexecute("cat /pipe.txt | sort | uniq | wc -l")
    assert resp.exit_code == 0
    assert "3" in resp.output


@pytest.mark.asyncio
async def test_upload_and_download(backend):
    files = [("/up1.txt", b"content1"), ("/up2.txt", b"content2")]
    up_results = await backend.aupload_files(files)
    assert all(r.error is None for r in up_results)

    down_results = await backend.adownload_files(["/up1.txt", "/up2.txt"])
    assert down_results[0].content == b"content1"
    assert down_results[1].content == b"content2"


class NoLists(Policy):
    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        return Deny("no lists") if ctx.command == "ls" else None


@pytest.mark.asyncio
async def test_als_names_the_reason_beside_a_refusal():
    # stderr is bash's bare `Permission denied`; the reason rides the
    # refusal record, and the error text appends it as one more line.
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[NoLists()],
    )
    result = await LangchainWorkspace(ws).als("/")
    assert result.entries is None
    assert result.error == "ls: Permission denied\npolicy denied: no lists"


@pytest.mark.asyncio
async def test_file_operations_act_as_the_session():
    ws = Workspace(
        {"/": RAMVFS(), "/vault": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"guarded": {"paths": {"hide": ["/vault"]}}},
    )
    await ws.shell("echo key > /vault/key.txt")
    ws.create_session("agent", profile="guarded")
    backend = LangchainWorkspace(ws, session_id="agent")
    try:
        read = await backend.aread("/vault/key.txt")
        downloaded = await backend.adownload_files(["/vault/key.txt"])
        listed = await backend.als("/")
    finally:
        await ws.close()
    assert read.error is not None
    assert downloaded[0].content is None
    assert all("vault" not in entry["path"] for entry in listed.entries)
