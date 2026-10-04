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

import pytest

from mirage.shell.console import Channel, JobConsole, Tee, Terminal
from mirage.shell.descriptors import Recorder


@pytest.mark.asyncio
async def test_a_line_takes_what_reached_the_terminal_in_order():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"early\n")
    await tty.emit(Channel.STDOUT, b"line\n")
    await tty.emit(Channel.STDERR, b"warn\n")
    await tty.jobs.emit(Channel.STDOUT, b"late\n")
    assert tty.take() == (b"early\nline\nlate\n", b"warn\n")
    assert tty.take() == (b"", b"")


@pytest.mark.asyncio
async def test_a_job_writes_into_the_statement_running():
    tty = Terminal()
    statement = Recorder()
    tty.jobs.recorder = statement
    await tty.jobs.emit(Channel.STDOUT, b"bg\n")
    tty.jobs.recorder = None
    await tty.jobs.emit(Channel.STDOUT, b"after\n")
    assert statement.chunks == [(Channel.STDOUT, b"bg\n")]
    assert tty.take() == (b"after\n", b"")


@pytest.mark.asyncio
async def test_a_reader_gets_what_waited_and_then_everything():
    tty = Terminal()
    await tty.jobs.emit(Channel.STDOUT, b"waited\n")
    reader = JobConsole()
    await tty.attach(reader)
    await tty.emit(Channel.STDOUT, b"now\n")
    assert await reader.snapshot(Channel.STDOUT) == b"waited\nnow\n"
    assert tty.take() == (b"", b"")


@pytest.mark.asyncio
async def test_an_abandoned_line_keeps_only_its_jobs_output():
    tty = Terminal()
    await tty.emit(Channel.STDOUT, b"line\n")
    await tty.jobs.emit(Channel.STDOUT, b"job\n")
    tty.drop_line()
    assert tty.take() == (b"job\n", b"")


@pytest.mark.asyncio
async def test_bounded_output_goes_back_ahead_of_later_output():
    tty = Terminal()
    await tty.emit(Channel.STDOUT, b"long line\n")
    out, err = tty.drain()
    await tty.jobs.emit(Channel.STDOUT, b"later\n")
    tty.put_back(out[:4], err)
    assert tty.take() == (b"longlater\n", b"")


@pytest.mark.asyncio
async def test_tee_keeps_the_console_and_copies_the_bytes():
    console, copy = JobConsole(), JobConsole()
    tee = Tee(console, copy)
    await tee.emit(Channel.STDOUT, b"x")
    assert await console.snapshot(Channel.STDOUT) == b"x"
    assert await copy.snapshot(Channel.STDOUT) == b"x"
