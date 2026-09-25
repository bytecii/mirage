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

from mirage import MountMode, Workspace
from mirage.core.bin.refuse import refuse
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.ram import RAMVFS


def test_view_registers_reads_and_refuses_every_write_op():
    vfs = BinViewVFS(lambda: ["ls"], lambda n: "ls" if n == "ls" else None)
    names = {cmd.name for cmd in vfs.commands()}
    assert {"cat", "ls", "stat"} <= names
    assert not {"rm", "touch", "cp"} & names
    ops = {op.name: op for op in vfs.ops_list()}
    assert {"read", "readdir", "stat"} <= set(ops)
    for name in ("write", "append", "create", "mkdir", "unlink", "rmdir",
                 "rename", "truncate", "setattr"):
        assert ops[name].write and ops[name].fn is refuse


@pytest.mark.asyncio
async def test_a_write_into_the_view_is_refused_as_read_only():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("echo x > /usr/bin/ls")
    assert io.exit_code == 1
    assert await io.stderr_str() == "/usr/bin/ls: Read-only file system\n"
    io = await ws.shell("chmod 644 /usr/bin/ls; stat -c %a /usr/bin/ls")
    assert await io.stderr_str() == "chmod: read-only mount at /usr/bin/\n"
    assert await io.stdout_str() == "755\n"
