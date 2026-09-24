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

from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.errors import PipeClosed


@pytest.mark.asyncio
async def test_reader_close_releases_a_blocked_writer_and_refuses_more_output(
):
    pipe = PipeConsole()
    writer = asyncio.create_task(pipe.emit(Channel.STDOUT, b"first"))
    stream = pipe.stream()
    assert await asyncio.wait_for(anext(stream), 1) == b"first"
    assert not writer.done()
    await stream.aclose()
    await asyncio.wait_for(writer, 1)
    with pytest.raises(PipeClosed):
        await pipe.emit(Channel.STDOUT, b"second")


@pytest.mark.asyncio
async def test_stderr_is_retained_without_waiting_for_a_stdout_reader():
    pipe = PipeConsole()
    await asyncio.wait_for(pipe.emit(Channel.STDERR, b"warning"), 1)
    assert await pipe.snapshot(Channel.STDERR) == b"warning"
