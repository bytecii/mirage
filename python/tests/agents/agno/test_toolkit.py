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

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.agno import MirageToolkit


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def toolkit(workspace):
    return MirageToolkit(workspace)


def test_registers_sync_and_async_tools(toolkit):
    expected = {"shell", "read", "write", "edit", "ls", "grep", "glob"}
    assert set(toolkit.functions) == expected
    assert set(toolkit.async_functions) == expected


def test_sync_tools(toolkit):
    assert toolkit.write("/notes/hello.txt", "hello world\n") == (
        "Written: /notes/hello.txt"
    )
    assert toolkit.read("/notes/hello.txt") == "     1\thello world\n"
    assert toolkit.edit("/notes/hello.txt", "world", "there").startswith(
        "Edited:"
    )
    assert toolkit.ls("/notes") == "hello.txt\n"
    assert toolkit.grep("THERE", "/notes", ignore_case=True) == (
        "/notes/hello.txt:1:hello there\n"
    )
    assert toolkit.glob("**/*.txt") == "/notes/hello.txt\n"
    assert toolkit.shell("find /notes -type f | wc -l") == "1\n"


@pytest.mark.asyncio
async def test_async_tools(toolkit):
    await toolkit.awrite("/notes/hello.txt", "hello async\n")
    assert await toolkit.aread("/notes/hello.txt") == "     1\thello async\n"
    assert await toolkit.als("/notes") == "hello.txt\n"
    assert await toolkit.agrep("hello", "/notes") == (
        "/notes/hello.txt:1:hello async\n"
    )
    assert await toolkit.aglob("*.txt", "/notes") == "/notes/hello.txt\n"
    assert await toolkit.ashell("find /notes -type f | wc -l") == "1\n"
