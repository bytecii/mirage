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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import dispatched


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["cat", "head -n 1"])
async def test_a_file_in_dev_is_read_at_the_dispatcher(command):
    # cat and head read /dev in ranges, which /dev/zero answers without
    # end; each range is a dispatcher read, so the gates judge the file
    # before any byte is printed.
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo s > /dev/secret")
        seen = dispatched(ws)
        read = await ws.shell(f"{command} /dev/secret")
        assert await read.stdout_str() == "s\n"
        assert ("read", "/dev/secret") in seen
        zero = await ws.shell(f"{command} /dev/zero | head -c 3 | wc -c")
        assert await zero.stdout_str() == "3\n"
    finally:
        await ws.close()
